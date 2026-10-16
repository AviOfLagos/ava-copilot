import type { RunRecord } from '@extension/storage';

/** Where a run handed over from a chat stands, for its card in the chat. Pure, shared with the panel. */
export type HandoffState = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped';

export function handoffState(run: Pick<RunRecord, 'status'>): HandoffState {
  switch (run.status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'waiting_user':
      return 'waiting';
    case 'succeeded':
      return 'done';
    case 'cancelled':
      return 'stopped';
    default:
      return 'failed';
  }
}
