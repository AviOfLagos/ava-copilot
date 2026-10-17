import { useSyncExternalStore } from 'react';
import {
  activeCatalog,
  downloadBytes,
  downloadedModels,
  downloadModels,
  removeModel,
  toAppError,
} from '@extension/shared';
import type { VoiceModelComponentId } from '@extension/shared';

/**
 * The voice model download running in this page (the side panel downloads them itself, into the extension's own
 * storage): its progress for the card and Settings, cancel, and the same state for other extension pages over a
 * BroadcastChannel (only one download runs at a time anywhere; the store holds a Web Lock). When it finishes the
 * background is told, so it reads what is installed again before the feature starts.
 */

export type DownloadErrorKind = 'network' | 'checksum' | 'space' | 'other';

export interface DownloadState {
  phase: 'idle' | 'downloading' | 'done' | 'failed';
  ids: VoiceModelComponentId[];
  received: number;
  total: number;
  error?: DownloadErrorKind;
  // Running in another extension page: shown, and cancelled through it
  remote?: boolean;
}

const IDLE: DownloadState = { phase: 'idle', ids: [], received: 0, total: 0 };
const CHANNEL = 'nex-voice-models';
// Progress is passed on at most this often
const PROGRESS_MS = 150;

let state: DownloadState = IDLE;
let controller: AbortController | null = null;
let running: Promise<boolean> | null = null;
let lastEmit = 0;
const listeners = new Set<() => void>();

const channel: BroadcastChannel | null = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
channel?.addEventListener('message', event => {
  const message = event.data as { type?: string; state?: DownloadState };
  if (message?.type === 'cancel') {
    controller?.abort();
    return;
  }
  if (message?.type === 'state' && message.state && !controller) {
    set(
      message.state.phase === 'downloading' ? { ...message.state, remote: true } : { ...message.state, remote: false },
      false,
    );
  }
});

function set(next: DownloadState, share = true): void {
  state = next;
  for (const listener of listeners) listener();
  if (share) channel?.postMessage({ type: 'state', state: next });
}

export function downloadState(): DownloadState {
  return state;
}

export function subscribeDownloads(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDownloadState(): DownloadState {
  return useSyncExternalStore(subscribeDownloads, downloadState);
}

/** The error the user is shown for a failed download. */
export function downloadErrorKind(error: unknown): DownloadErrorKind {
  const problem = toAppError(error);
  const cause = (problem.cause as { name?: string } | undefined)?.name;
  if (cause === 'QuotaExceededError' || /quota/i.test(problem.message)) return 'space';
  if (problem.kind === 'invalid') return 'checksum';
  if (['network', 'timeout', 'unavailable', 'rate_limit', 'not_found', 'forbidden'].includes(problem.kind)) {
    return 'network';
  }
  return 'other';
}

/** Megabytes, rounded for people. */
export const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / 1e6));

/** What the components still to be downloaded weigh. */
export function bytesFor(ids: VoiceModelComponentId[]): number {
  const catalog = activeCatalog();
  return ids.reduce((sum, id) => sum + (catalog[id] ? downloadBytes(catalog[id]) : 0), 0);
}

/**
 * Downloads the components (the ones not already there), resolving true once all are ready; false when it was
 * cancelled or failed (the state says why). A download already running here is joined, not started twice.
 * `changed` tells the background.
 */
export function startDownload(ids: VoiceModelComponentId[], changed: () => Promise<unknown>): Promise<boolean> {
  if (running) return running;
  if (state.remote && state.phase === 'downloading') return Promise.resolve(false);
  running = (async () => {
    const here = await downloadedModels().catch(() => ({}) as Record<string, unknown>);
    const todo = ids.filter(id => !(id in here));
    const catalog = activeCatalog();
    const sizes = Object.fromEntries(todo.map(id => [id, catalog[id] ? downloadBytes(catalog[id]) : 0]));
    const total = todo.reduce((sum, id) => sum + sizes[id], 0);
    controller = new AbortController();
    set({ phase: 'downloading', ids: todo, received: 0, total });
    // Kept when the browser runs short of space (the extension also has unlimitedStorage)
    void navigator.storage?.persist?.().catch(() => false);
    const got: Partial<Record<VoiceModelComponentId, number>> = {};
    try {
      await downloadModels(todo, {
        signal: controller.signal,
        onProgress: progress => {
          got[progress.id] = progress.received;
          const now = Date.now();
          if (now - lastEmit < PROGRESS_MS && progress.received < progress.total) return;
          lastEmit = now;
          const received = Object.values(got).reduce((sum, bytes) => sum + (bytes ?? 0), 0);
          set({ ...state, received: Math.min(total, received) });
        },
      });
      await changed().catch(() => {});
      set({ phase: 'done', ids: todo, received: total, total });
      return true;
    } catch (error) {
      const cancelled = controller?.signal.aborted || toAppError(error).kind === 'cancelled';
      await changed().catch(() => {});
      set(cancelled ? IDLE : { ...state, phase: 'failed', error: downloadErrorKind(error) });
      return false;
    } finally {
      controller = null;
      running = null;
    }
  })();
  return running;
}

/** Stops the download (here, or in the page running it). What was checked so far is kept for next time. */
export function cancelDownload(): void {
  if (controller) controller.abort();
  else channel?.postMessage({ type: 'cancel' });
}

/** Forgets a failure, so the card or row can offer the download again. */
export function clearDownloadError(): void {
  if (state.phase === 'failed' || state.phase === 'done') set(IDLE);
}

/** Deletes a downloaded component. */
export async function removeDownloaded(id: VoiceModelComponentId, changed: () => Promise<unknown>): Promise<void> {
  await removeModel(id);
  await changed().catch(() => {});
  set(IDLE);
}
