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
  // "pulse|08:30" → when it ran; 0 when it was skipped as missed; -1 while it runs (still -1 on a later tick
  // means the background stopped half-way through it)
  ran: Record<string, number>;
  findings: {
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
  findings: { failed: [] },
  checkins: { offers: 0, lastOfferAt: 0, silenced: false, open: {} },
  enabled,
});

const storage = createStorage<RoundsState>('rounds', emptyRoundsState(''), {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

// Every change reads the state, changes it and writes it back. One at a time, or two changes made at once
// would each write back what they read and one would be lost (an offer counted once instead of twice).
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

// What to do with yesterday's state before it is forgotten (close the offers nobody answered). Set by the
// background; a page that only reads never sets it.
let onNewDay: ((yesterday: RoundsState) => Promise<void>) | null = null;

/** Today's state, and yesterday's when the stored one is from another day. Writes nothing. */
const readToday = async (day: string): Promise<{ state: RoundsState; stale: RoundsState | null; stored: boolean }> => {
  const state = await storage.get();
  if (state?.day === day) return { state, stale: null, stored: true };
  return { state: emptyRoundsState(day, state?.enabled ?? true), stale: state?.day ? state : null, stored: false };
};

/** Today's state, written when the day turned: yesterday's goes to `onNewDay` first. Call inside `serial`. */
async function turnDay(day: string): Promise<RoundsState> {
  const { state, stale, stored } = await readToday(day);
  if (stored) return state;
  if (stale) await onNewDay?.(stale).catch(() => undefined);
  await storage.set(state);
  return state;
}

export const roundsStore = {
  ...storage,

  /** What happens to yesterday's state when the day turns. */
  setNewDayHandler(handler: (yesterday: RoundsState) => Promise<void>): void {
    onNewDay = handler;
  },

  /** Today's state as it would be, without writing anything: for a screen that only looks. */
  async peek(day: string): Promise<RoundsState> {
    return (await readToday(day)).state;
  },

  /** Today's state. When the stored one is another day's, it is dropped, except whether rounds are on. */
  today(day: string): Promise<RoundsState> {
    return serial(() => turnDay(day));
  },

  /** Changes today's state. Changes run one at a time, each on what the one before wrote. */
  update(day: string, change: (state: RoundsState) => RoundsState): Promise<RoundsState> {
    return serial(async () => {
      const next = change(await turnDay(day));
      await storage.set(next);
      return next;
    });
  },

  setEnabled(enabled: boolean): Promise<void> {
    return serial(async () => {
      const state = (await storage.get()) ?? emptyRoundsState('');
      await storage.set({ ...state, enabled });
    });
  },
};
