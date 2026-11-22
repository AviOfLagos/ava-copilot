import { AppError, toAppError } from '@extension/shared';
import { safeFolderName } from '@extension/storage';
import type { OnceRecord, OnceStep, RecordingPlace, RecordingRecord, RecordingStore } from '@extension/storage';
import { RECORDING_CHUNK_BYTES } from '@src/shared/lib/protocol/companion';
import type { RecordingBeginRequest } from '@src/shared/lib/protocol/companion';
import type { DriveRecordings } from './drive';
import { ROOT_FOLDER } from './drive';

/**
 * Saving a finished recording (docs/pm-desk.md, Part 7): to Google Drive when the `google_drive` connector is
 * signed in, else to the Mac through Ava Brain when it is paired, else it waits for a download from the panel
 * and the Inbox offers, once, to connect Drive.
 *
 * Nothing is done twice (rule 7):
 * - Drive: the upload's do-once key is written before the session opens, and the session address is saved before
 *   a byte is sent. A retry asks Drive how far that session got and carries on into the same file. Drive makes a
 *   file only when its last byte is in, so a session cut off before its address was saved leaves nothing behind
 *   and a new one is safe. Once the file is in, its id goes on the key, and a later retry finds it there.
 * - Ava Brain: it keeps the path of each recording it saved and answers a repeat with it.
 * The file in Drive starts private: nothing here sets a permission (see ./share.ts).
 */

type OnceLike = {
  get(key: string): Promise<OnceRecord | undefined>;
  begin(step: OnceStep, options?: { again?: boolean }): Promise<{ fresh: boolean; record: OnceRecord }>;
  finish(key: string, result: string): Promise<void>;
  fail(key: string, reason: string): Promise<void>;
};

export interface BrainLike {
  paired(): Promise<boolean>;
  recordingBegin(
    request: RecordingBeginRequest,
  ): Promise<{ ok: true; uploadId: string; chunkBytes: number } | { ok: true; path: string }>;
  recordingChunk(uploadId: string, index: number, data: string): Promise<unknown>;
  recordingCommit(uploadId: string): Promise<{ ok: true; path: string }>;
}

export interface SaveDeps {
  store: RecordingStore;
  once: OnceLike;
  // The Drive client when the connector is signed in with file access; null when Drive is not connected
  drive: () => Promise<DriveRecordings | null>;
  brain: BrainLike;
  workspaceName: (workspaceId: string | null) => Promise<string | null>;
  // Tells the Inbox, once ever, that Drive would give links to share
  nudgeDrive: () => Promise<void>;
}

export const NO_WORKSPACE_FOLDER = 'No workspace';

/** The do-once step of one recording's save or share. The target is the recording's id: no content. */
export function recordingStep(record: Pick<RecordingRecord, 'id'>, what: string, round = 0): OnceStep {
  const scope = round ? `${what}:${round}` : what;
  return {
    taskId: `recording:${record.id}`,
    threadId: `recording:${record.id}`,
    what,
    scope,
    label:
      what === 'drive.upload'
        ? 'Save a recording to Drive'
        : what === 'brain.save'
          ? 'Save a recording on the Mac'
          : 'Share a recording',
    target: round ? `${record.id}:${round}` : record.id,
  };
}

export const onceKeyOf = (step: OnceStep) => `${step.taskId}|${step.what}|${step.target}`;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export type SaveOutcome = RecordingRecord['status'];

async function folderOf(deps: SaveDeps, record: RecordingRecord): Promise<string> {
  const name = record.workspaceId ? await deps.workspaceName(record.workspaceId) : null;
  return safeFolderName(name || NO_WORKSPACE_FOLDER);
}

async function toDrive(
  deps: SaveDeps,
  drive: DriveRecordings,
  record: RecordingRecord,
  blob: Blob,
  signal?: AbortSignal,
) {
  const step = recordingStep(record, 'drive.upload');
  const key = onceKeyOf(step);
  const kept = await deps.once.get(key);
  const folder = await folderOf(deps, record);
  const where = `${ROOT_FOLDER} / ${folder}`;
  // Finished before, but the record never heard: the file is there, so it is not sent again
  const doneFile = kept?.status === 'done' ? kept.result?.match(/^file:(.+)$/)?.[1] : undefined;
  if (doneFile) {
    const place: RecordingPlace = { where: 'drive', fileId: doneFile, folder: where, webViewLink: null };
    await deps.store.update(record.id, { status: 'saved', saved: place, upload: null, error: null });
    return;
  }
  // A save the user asked for again, or a retry: Drive's session (below) is what keeps it to one file
  await deps.once.begin(step, { again: true });
  let session = record.upload?.sessionUrl ?? null;
  let from = 0;
  if (session) {
    const state = await drive.sessionStatus(session, blob.size);
    if ('gone' in state) session = null;
    else if (state.done) {
      await finishDrive(deps, record, key, state.file, where);
      return;
    } else from = state.next;
  }
  if (!session) {
    const parentId = await drive.folder([folder]);
    session = await drive.startSession({ name: record.fileName, parentId, mimeType: 'video/webm', size: blob.size });
    await deps.store.update(record.id, { upload: { sessionUrl: session, bytes: 0, startedAt: Date.now() } });
  }
  const sessionUrl = session;
  const file = await drive.send(
    sessionUrl,
    blob,
    from,
    async bytes => {
      await deps.store.update(record.id, {
        upload: { sessionUrl, bytes, startedAt: record.upload?.startedAt ?? Date.now() },
      });
    },
    signal,
  );
  await finishDrive(deps, record, key, file, where);
}

async function finishDrive(
  deps: SaveDeps,
  record: RecordingRecord,
  key: string,
  file: { id: string; webViewLink?: string | null },
  where: string,
) {
  const place: RecordingPlace = {
    where: 'drive',
    fileId: file.id,
    folder: where,
    webViewLink: file.webViewLink ?? null,
  };
  await deps.once.finish(key, `file:${file.id}`);
  await deps.store.update(record.id, { status: 'saved', saved: place, upload: null, error: null });
  // The video is in Drive now; the copy in the browser goes
  await deps.store.deleteChunks(record.id);
}

async function toBrain(deps: SaveDeps, record: RecordingRecord, blob: Blob) {
  const step = recordingStep(record, 'brain.save');
  const key = onceKeyOf(step);
  await deps.once.begin(step, { again: true });
  const begun = await deps.brain.recordingBegin({
    // A new id each time: the companion answers a repeated id from its cache, which would hand back an upload a
    // failed attempt left half-sent. A new begin replaces that upload; a recording already saved returns its path.
    requestId: `${record.id}-save-${crypto.randomUUID().slice(0, 8)}`,
    recordingId: record.id,
    folder: await folderOf(deps, record),
    fileName: record.fileName,
    bytes: blob.size,
  });
  let path: string;
  if ('path' in begun) path = begun.path;
  else {
    const size = Math.min(begun.chunkBytes, RECORDING_CHUNK_BYTES);
    for (let index = 0, offset = 0; offset < blob.size; index++, offset += size) {
      const part = new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer());
      await deps.brain.recordingChunk(begun.uploadId, index, toBase64(part));
    }
    path = (await deps.brain.recordingCommit(begun.uploadId)).path;
  }
  await deps.once.finish(key, 'saved');
  await deps.store.update(record.id, { status: 'saved', saved: { where: 'brain', path }, error: null });
  await deps.store.deleteChunks(record.id);
}

/**
 * Saves one recording wherever it can go. Throws a retryable AppError for a dropped connection (the job runs it
 * again and the upload carries on); anything else marks the recording failed with a plain sentence.
 *
 * @returns Where it stands afterwards
 */
export async function saveRecording(deps: SaveDeps, id: string, signal?: AbortSignal): Promise<SaveOutcome> {
  const record = await deps.store.get(id);
  if (!record) throw new AppError('not_found', 'That recording is gone.', { retryable: false });
  if (record.status === 'saved' || record.status === 'recording') return record.status;
  const blob = await deps.store.blob(id, record.mimeType);
  if (!blob || blob.size === 0) {
    await deps.store.update(id, { status: 'failed', error: 'Nothing was recorded.' });
    return 'failed';
  }
  await deps.store.update(id, { status: 'saving', error: null });
  try {
    const drive = await deps.drive();
    if (drive) await toDrive(deps, drive, record, blob, signal);
    else if (await deps.brain.paired().catch(() => false)) await toBrain(deps, record, blob);
    else {
      await deps.store.update(id, { status: 'waiting_download', error: null });
      await deps.nudgeDrive().catch(() => undefined);
      return 'waiting_download';
    }
    return 'saved';
  } catch (thrown) {
    const error = toAppError(thrown);
    if (error.retryable) {
      await deps.store.update(id, { status: 'saving', error: 'The connection dropped. Ava will carry on by itself.' });
      throw error;
    }
    // The session address is a credential for this file's upload; a failure that will not carry on drops it
    await deps.store.update(id, { status: 'failed', error: error.message, upload: null });
    throw new AppError(error.kind, error.message, { retryable: false, cause: thrown });
  }
}
