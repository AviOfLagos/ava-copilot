import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

// Token use and cost added up over a day or a chat session
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  calls: number;
  // Calls to a model with no known price; their cost is not in costUsd
  unpricedCalls: number;
  // Tokens (in and out) of those calls, held to their own daily cap
  unpricedTokens?: number;
}

export interface UsageRecord {
  // Keyed by local date, YYYY-MM-DD
  days: Record<string, UsageTotals>;
  // Keyed by chat session id
  sessions: Record<string, UsageTotals>;
}

export type UsageStorage = BaseStorage<UsageRecord> & {
  add: (sessionId: string, day: string, delta: UsageTotals) => Promise<void>;
  getDay: (day: string) => Promise<UsageTotals>;
  getSession: (sessionId: string) => Promise<UsageTotals>;
  clear: () => Promise<void>;
};

export const EMPTY_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  calls: 0,
  unpricedCalls: 0,
  unpricedTokens: 0,
};

const MAX_DAYS = 60;
const MAX_SESSIONS = 200;

const storage = createStorage<UsageRecord>(
  'usage',
  { days: {}, sessions: {} },
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
    calls: a.calls + b.calls,
    unpricedCalls: a.unpricedCalls + b.unpricedCalls,
    unpricedTokens: (a.unpricedTokens ?? 0) + (b.unpricedTokens ?? 0),
  };
}

// Keeps the entries with the largest keys (days) or the most recently added ones (sessions)
function keepLast<T>(entries: Record<string, T>, max: number, sortKeys: boolean): Record<string, T> {
  const keys = Object.keys(entries);
  if (keys.length <= max) {
    return entries;
  }
  const kept = (sortKeys ? keys.sort() : keys).slice(-max);
  return Object.fromEntries(kept.map(key => [key, entries[key]]));
}

/**
 * The local calendar day as YYYY-MM-DD. The daily cap resets at the user's midnight.
 */
export function localDay(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export const usageStore: UsageStorage = {
  ...storage,
  async add(sessionId: string, day: string, delta: UsageTotals) {
    await storage.set(stored => {
      // The key can be missing after the user wipes extension data
      const current = stored ?? { days: {}, sessions: {} };
      const days = { ...current.days, [day]: addTotals(current.days[day] ?? EMPTY_USAGE, delta) };
      // Re-inserting moves the session to the end, so the oldest idle sessions are dropped first
      const { [sessionId]: previous, ...otherSessions } = current.sessions;
      const sessions = { ...otherSessions, [sessionId]: addTotals(previous ?? EMPTY_USAGE, delta) };
      return { days: keepLast(days, MAX_DAYS, true), sessions: keepLast(sessions, MAX_SESSIONS, false) };
    });
  },
  async getDay(day: string) {
    return (await storage.get())?.days?.[day] ?? EMPTY_USAGE;
  },
  async getSession(sessionId: string) {
    return (await storage.get())?.sessions?.[sessionId] ?? EMPTY_USAGE;
  },
  async clear() {
    await storage.set({ days: {}, sessions: {} });
  },
};

export * from './events';
