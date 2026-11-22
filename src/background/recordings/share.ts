import { AppError } from '@extension/shared';
import type { RecordingRecord, RecordingStore } from '@extension/storage';
import type { DriveRecordings } from './drive';
import { onceKeyOf, recordingStep } from './save';
import type { SaveDeps } from './save';

/**
 * Sharing a recording (docs/pm-desk.md, Part 7): "anyone with the link can comment", made only when Avi presses
 * "Share" on the task (or, later, "Looks right" on the after-call list, which calls `shareRecordingsFor`). These
 * functions are reached from panel commands only: no agent action, voice tool, rule or "allow every time" calls
 * them. "Stop sharing" removes the permission, so the link stops working, and takes the link off the task.
 *
 * Each share has its own do-once key (one per round, so sharing again after "Stop sharing" works). Drive's side is
 * idempotent too: a permission already there is kept, never made twice.
 */

export interface TaskLinks {
  addLink(taskId: string, link: { label: string; url: string }): Promise<void>;
  removeLink(taskId: string, url: string): Promise<void>;
}

export interface ShareDeps {
  store: RecordingStore;
  once: SaveDeps['once'];
  drive: SaveDeps['drive'];
  tasks: TaskLinks;
  now?: () => number;
}

export const recordingLinkLabel = (record: Pick<RecordingRecord, 'startedAt'>) => {
  const date = new Date(record.startedAt);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `Screen recording ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

async function driveOrFail(deps: ShareDeps): Promise<DriveRecordings> {
  const drive = await deps.drive();
  if (!drive) throw new AppError('auth', 'Connect Google Drive first (Connectors), then press Share again.');
  return drive;
}

function driveFile(record: RecordingRecord | undefined): { record: RecordingRecord; fileId: string } {
  if (!record) throw new AppError('not_found', 'That recording is gone.');
  if (record.saved?.where !== 'drive') {
    throw new AppError('invalid', 'Only a recording saved in Google Drive can be shared with a link.');
  }
  return { record, fileId: record.saved.fileId };
}

/** Makes one recording's link work for anyone who has it, and puts the link on its task. */
export async function shareRecording(deps: ShareDeps, id: string): Promise<RecordingRecord> {
  const { record, fileId } = driveFile(await deps.store.get(id));
  if (record.share.state === 'shared' && record.share.link) return record;
  const round = record.share.round + 1;
  const step = recordingStep(record, 'drive.share', round);
  const key = onceKeyOf(step);
  const drive = await driveOrFail(deps);
  await deps.once.begin(step, { again: true });
  const { permissionId, link } = await drive.share(fileId);
  const url = link ?? `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
  await deps.once.finish(key, 'shared');
  const now = deps.now?.() ?? Date.now();
  const updated = await deps.store.update(id, {
    share: { state: 'shared', permissionId, link: url, sharedAt: now, stoppedAt: null, round },
    saved: { ...record.saved!, webViewLink: url } as RecordingRecord['saved'],
  });
  await deps.tasks.addLink(record.taskId, { label: recordingLinkLabel(record), url });
  return updated!;
}

/** Private again: the link stops working for anyone but Avi, and comes off the task. */
export async function stopSharing(deps: ShareDeps, id: string): Promise<RecordingRecord> {
  const { record, fileId } = driveFile(await deps.store.get(id));
  const drive = await driveOrFail(deps);
  const step = recordingStep(record, 'drive.unshare', record.share.round);
  await deps.once.begin(step, { again: true });
  await drive.unshare(fileId, record.share.permissionId);
  await deps.once.finish(onceKeyOf(step), 'private');
  const now = deps.now?.() ?? Date.now();
  const updated = await deps.store.update(id, {
    share: { ...record.share, state: 'private', permissionId: null, stoppedAt: now },
  });
  if (record.share.link) await deps.tasks.removeLink(record.taskId, record.share.link);
  return updated!;
}

export interface SharedResult {
  taskId: string;
  recordingId: string;
  link: string | null;
  // Why it was not shared: not in Drive (on the Mac, downloaded, still saving), or what Drive said
  skipped?: string;
}

/**
 * Shares every recording of these tasks that is in Drive. This is what a "Looks right" on the after-call list
 * (issue #108) calls, and like "Share" it is reached only from the user's click in the panel.
 */
export async function shareRecordingsFor(deps: ShareDeps, taskIds: string[]): Promise<SharedResult[]> {
  const results: SharedResult[] = [];
  for (const taskId of [...new Set(taskIds)]) {
    for (const record of await deps.store.forTask(taskId)) {
      if (record.saved?.where !== 'drive') {
        results.push({ taskId, recordingId: record.id, link: null, skipped: 'Not in Google Drive.' });
        continue;
      }
      // Stopped by hand: only that recording's own Share button makes it public again
      if (record.share.stoppedAt) {
        results.push({ taskId, recordingId: record.id, link: null, skipped: 'Sharing was stopped for it.' });
        continue;
      }
      try {
        const shared = await shareRecording(deps, record.id);
        results.push({ taskId, recordingId: record.id, link: shared.share.link });
      } catch (error) {
        results.push({
          taskId,
          recordingId: record.id,
          link: null,
          skipped: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return results;
}
