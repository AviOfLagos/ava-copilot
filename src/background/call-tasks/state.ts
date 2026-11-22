import { meetingStore } from '@extension/storage';
import type { CallTasksState, MeetingRecord } from '@extension/storage';
import { emptyCallState } from './engine';

/**
 * A call's task state (`MeetingRecord.callTasks`), changed one writer at a time per meeting: the engine, the signal
 * check and the panel's commands all go through `change`, so none of them loses another's write.
 */
export interface MeetingReadWrite {
  get(id: string): Promise<MeetingRecord | undefined>;
  update(id: string, changes: Partial<MeetingRecord>): Promise<unknown>;
}

export function createCallState(store: MeetingReadWrite = meetingStore) {
  const chains = new Map<string, Promise<unknown>>();
  return {
    async get(meetingId: string): Promise<CallTasksState | undefined> {
      return (await store.get(meetingId))?.callTasks;
    },
    change(meetingId: string, change: (state: CallTasksState) => CallTasksState): Promise<CallTasksState> {
      const previous = chains.get(meetingId) ?? Promise.resolve();
      const next = previous
        .catch(() => {})
        .then(async () => {
          const meeting = await store.get(meetingId);
          if (!meeting) throw new Error('That meeting is gone.');
          const state = change(meeting.callTasks ?? emptyCallState());
          await store.update(meetingId, { callTasks: state });
          return state;
        });
      chains.set(
        meetingId,
        next.catch(() => {}),
      );
      return next;
    },
  };
}

export type CallState = ReturnType<typeof createCallState>;

export const callState = createCallState();
