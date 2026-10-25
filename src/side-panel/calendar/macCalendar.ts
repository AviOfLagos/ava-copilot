import type { CalendarAccess, MacCalendar } from '@src/shared/lib/protocol/companion';

/** What the Calendar card shows for the Mac's Calendar, from Ava Brain's answer. */
export type MacCardState =
  // Ava Brain is not paired: the iCal address is the way (with a hint to pair)
  | 'unpaired'
  | 'loading'
  // Ava Brain did not answer
  | 'offline'
  // macOS has not asked yet: the "Allow access" button shows its prompt
  | 'needs_permission'
  // Refused, restricted or write-only: the steps in System Settings
  | 'denied'
  // Not macOS, or osascript missing
  | 'unavailable'
  | 'ready';

export interface MacStatusReply {
  paired: boolean;
  access?: CalendarAccess;
  calendars?: MacCalendar[];
  message?: string | null;
}

export function macCardState(input: { reply: MacStatusReply | null; error: string | null }): MacCardState {
  if (input.error) return 'offline';
  if (!input.reply) return 'loading';
  if (!input.reply.paired) return 'unpaired';
  switch (input.reply.access) {
    case 'granted':
      return 'ready';
    case 'not_determined':
      return 'needs_permission';
    case 'denied':
    case 'restricted':
    case 'write_only':
      return 'denied';
    default:
      return 'unavailable';
  }
}

/** Ticks or unticks one calendar. null means all of them, and ticking the last one back returns to null. */
export function toggleCalendar(selected: string[] | null, all: string[], id: string, on: boolean): string[] | null {
  const current = new Set(selected ?? all);
  if (on) current.add(id);
  else current.delete(id);
  const next = all.filter(item => current.has(item));
  return next.length === all.length ? null : next;
}

/** Calendars grouped by the account they sync from, in the order macOS lists them. */
export function byAccount(calendars: MacCalendar[]): { account: string; calendars: MacCalendar[] }[] {
  const groups = new Map<string, MacCalendar[]>();
  for (const calendar of calendars) {
    const account = calendar.account || 'Other';
    groups.set(account, [...(groups.get(account) ?? []), calendar]);
  }
  return [...groups].map(([account, items]) => ({ account, calendars: items }));
}
