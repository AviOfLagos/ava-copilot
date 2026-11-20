import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';

/**
 * What the rounds and check-ins remember between ticks (docs/growth-team.md, Part 4): which round slots ran
 * today, what the last rounds found (for the offer a check-in makes), and how many offers went out today.
 */

export type RoundId = 'pulse' | 'mail' | 'stuck';

export interface RoundsState {
  // The user's local day these records are about, YYYY-MM-DD; another day starts clean
  day: string;
  // "pulse|08:30" → when it ran (or was skipped as missed: 0)
  ran: Record<string, number>;
  findings: {
    // From the mail round's digest, when it says a count
    mailUnread: number | null;
    mailAt: number | null;
    // Chats that failed and could be tried again: their ids and titles
    failed: { threadId: string; title: string }[];
  };
  checkins: {
    offers: number;
    lastOfferAt: number;
    // "Not today": no more offers until tomorrow
    silenced: boolean;
    // What was offered, by request id, so the answer knows what to start
    open: Record<string, { kind: 'mail' | 'retry'; threadIds?: string[] }>;
  };
  // Off: no round runs and no offer is made
  enabled: boolean;
}

export const emptyRoundsState = (day: string, enabled = true): RoundsState => ({
  day,
  ran: {},
  findings: { mailUnread: null, mailAt: null, failed: [] },
  checkins: { offers: 0, lastOfferAt: 0, silenced: false, open: {} },
  enabled,
});

const storage = createStorage<RoundsState>('rounds', emptyRoundsState(''), {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const roundsStore = {
  ...storage,

  /** Today's state: yesterday's is dropped, except whether rounds are on. */
  async today(day: string): Promise<RoundsState> {
    const state = (await storage.get()) ?? emptyRoundsState(day);
    if (state.day === day) return state;
    const fresh = emptyRoundsState(day, state.enabled ?? true);
    await storage.set(fresh);
    return fresh;
  },

  async update(day: string, change: (state: RoundsState) => RoundsState): Promise<RoundsState> {
    const next = change(await roundsStore.today(day));
    await storage.set(next);
    return next;
  },

  async setEnabled(enabled: boolean): Promise<void> {
    const state = (await storage.get()) ?? emptyRoundsState('');
    await storage.set({ ...state, enabled });
  },
};
