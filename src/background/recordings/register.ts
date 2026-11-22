// Screen recordings for a task (docs/pm-desk.md, Part 7). The panel records (getDisplayMedia must run inside the
// user's click, and the offscreen document is the meeting recorder's); the background owns the records, saves the
// file and shares it. Commands come from extension pages only.
import { z } from 'zod';
import { toAppError } from '@extension/shared';
import { RECORDING_ID_PATTERN, recordingSettingsStore, recordingStore, taskStore } from '@extension/storage';
import type { RecordingRecord } from '@extension/storage';
import { jobs, registerJobHandler } from '../jobs/runner';
import { createLogger } from '../log';
import { answerOneOff, registerCommand, registerRecovery } from '../registry';
import { saveRecording } from './save';
import { saveDeps, shareDeps } from './service';
import { shareRecording, shareRecordingsFor, stopSharing } from './share';

const logger = createLogger('Recordings');

export const SAVE_JOB = 'recording_save';
export const RECORDING_PORT = 'screen-recording';
// A recording whose panel has not written for this long is over: the panel closed or the browser stopped
const STALE_MS = 30_000;
// Copies kept for a download only, after which the browser's copy goes
const DOWNLOAD_KEEP_MS = 7 * 24 * 60 * 60_000;

const recordingId = z.string().regex(RECORDING_ID_PATTERN);
const taskIdSchema = z.string().min(1).max(40);
const endedBy = z.enum(['stop', 'call_ended', 'silence', 'limit', 'panel_closed', 'track_ended']);

async function queueSave(id: string): Promise<void> {
  await jobs.schedule({ kind: SAVE_JOB, key: `${SAVE_JOB}:${id}`, payload: { id } });
  void jobs.tick();
}

// The job runner gives a retryable failure this many runs (MAX_ATTEMPTS in jobs/runner.ts)
const SAVE_ATTEMPTS = 5;

registerJobHandler(SAVE_JOB, async (job, signal) => {
  const id = (job.payload as { id?: unknown } | null)?.id;
  if (typeof id !== 'string') return;
  try {
    await saveRecording(saveDeps, id, signal);
  } catch (thrown) {
    const error = toAppError(thrown);
    // The last run: say so, so the task offers Try again and Download instead of "Saving…" for good
    if (error.retryable && job.attempts >= SAVE_ATTEMPTS) {
      await recordingStore.update(id, {
        status: 'failed',
        error: 'It could not be saved after several tries. Try again, or download it.',
      });
    }
    throw thrown;
  }
});

/** Closes a recording the panel left (closed, crashed) with what it captured, and saves it. */
export async function closeRecording(
  id: string,
  how: RecordingRecord['endedBy'],
  durationMs?: number,
): Promise<RecordingRecord | undefined> {
  const record = await recordingStore.get(id);
  if (!record || record.status !== 'recording') return record;
  const endedAt = Date.now();
  const updated = await recordingStore.update(id, {
    status: 'captured',
    endedAt,
    endedBy: how,
    durationMs: durationMs ?? Math.max(0, (record.lastChunkAt ?? endedAt) - record.startedAt),
  });
  await queueSave(id);
  return updated;
}

registerRecovery('recordings', async () => {
  const now = Date.now();
  for (const record of await recordingStore.withStatus('recording')) {
    if ((record.lastChunkAt ?? record.startedAt) < now - STALE_MS) await closeRecording(record.id, 'panel_closed');
  }
  // A save the background stopped in the middle of: the job runner has its own record, this is for one it lost
  for (const status of ['captured', 'saving'] as const) {
    for (const record of await recordingStore.withStatus(status)) await queueSave(record.id);
  }
  for (const record of await recordingStore.withStatus('saved')) {
    if (record.saved?.where === 'download' && record.saved.at < now - DOWNLOAD_KEEP_MS) {
      await recordingStore.deleteChunks(record.id);
    }
  }
});

function command<S extends z.ZodType>(
  type: `recordings_${string}`,
  schema: S,
  run: (input: z.infer<S>) => Promise<unknown>,
): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      context.reply({ type: 'recordings_ok', requestId: context.requestId, result: await run(input) });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
    }
  });
}

// The panel has a stream from the picker (inside Avi's click) and is about to record it
command(
  'recordings_begin',
  z.object({
    taskId: taskIdSchema,
    surface: z.enum(['browser', 'window', 'monitor']).nullable(),
    withMic: z.boolean(),
    withTabAudio: z.boolean(),
    mimeType: z.string().regex(/^video\/webm(;[a-z0-9=,.\s]*)?$/i),
  }),
  async input => {
    const task = await taskStore.get(input.taskId);
    if (!task) throw new Error('That task is no longer on the board.');
    const record = await recordingStore.create({
      taskId: task.id,
      workspaceId: task.workspaceId,
      title: task.title,
      surface: input.surface,
      withMic: input.withMic,
      withTabAudio: input.withTabAudio,
      mimeType: input.mimeType,
    });
    const { maxMinutes } = await recordingSettingsStore.getSettings();
    return { id: record.id, maxMinutes };
  },
);

command('recordings_finish', z.object({ id: recordingId, endedBy, durationMs: z.number().int().min(0) }), input =>
  closeRecording(input.id, input.endedBy, input.durationMs),
);

// "Try again" on a recording whose save failed or waits for a download
command('recordings_save', z.object({ id: recordingId }), async input => {
  const record = await recordingStore.get(input.id);
  if (!record) throw new Error('That recording is gone.');
  if (!['failed', 'waiting_download', 'captured', 'saving'].includes(record.status)) return record;
  if (!(await recordingStore.hasChunks(record.id))) throw new Error('The video is no longer in the browser.');
  await recordingStore.update(record.id, { status: 'captured', error: null });
  await queueSave(record.id);
  return recordingStore.get(record.id);
});

// The panel started the download of a recording that could go nowhere else
command('recordings_downloaded', z.object({ id: recordingId }), async input => {
  const record = await recordingStore.get(input.id);
  if (!record) throw new Error('That recording is gone.');
  if (record.status !== 'waiting_download' && record.status !== 'failed') return record;
  return recordingStore.update(record.id, {
    status: 'saved',
    saved: { where: 'download', fileName: record.fileName, at: Date.now() },
    error: null,
  });
});

// Avi's "Share" on the task, and "Stop sharing". Never called by an agent, a voice tool or a rule
command('recordings_share', z.object({ id: recordingId }), input => shareRecording(shareDeps, input.id));
command('recordings_unshare', z.object({ id: recordingId }), input => stopSharing(shareDeps, input.id));
// "Looks right" on the after-call list (issue #108) sends this with the list's tasks
command('recordings_share_tasks', z.object({ taskIds: z.array(taskIdSchema).min(1).max(100) }), input =>
  shareRecordingsFor(shareDeps, input.taskIds),
);

const fromExtensionPage = (sender: chrome.runtime.MessageSender) =>
  sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));

// Only pages of the extension send these, never a web page and never an agent
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!fromExtensionPage(sender)) return;
  if (typeof message?.type !== 'string' || !message.type.startsWith('recordings_')) return;
  return answerOneOff(message, sendResponse);
});

// The recording panel holds this port open while it records. When the panel closes, the port drops and the
// recording ends with what was written (a chunk in flight gets a moment to land).
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== RECORDING_PORT) return;
  if (!port.sender || !fromExtensionPage(port.sender)) {
    port.disconnect();
    return;
  }
  const watched = new Set<string>();
  port.onMessage.addListener(message => {
    const id = (message as { id?: unknown } | null)?.id;
    if ((message as { type?: unknown })?.type === 'watch' && typeof id === 'string' && RECORDING_ID_PATTERN.test(id)) {
      watched.add(id);
    }
    if ((message as { type?: unknown })?.type === 'done' && typeof id === 'string') watched.delete(id);
  });
  port.onDisconnect.addListener(() => {
    if (watched.size === 0) return;
    setTimeout(() => {
      for (const id of watched) {
        void closeRecording(id, 'panel_closed').catch(error =>
          logger.warning('Could not close a recording its panel left', toAppError(error).kind),
        );
      }
    }, 1_500);
  });
});
