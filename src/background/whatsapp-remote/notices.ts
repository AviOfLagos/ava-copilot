import type { NoticeKind } from '../notices';
import type { WhatsAppRemoteSettings } from './state';

/** "HH:MM" to minutes since midnight, or null when empty or not well formed. */
function minutesOf(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours > 23 || minutes > 59 ? null : hours * 60 + minutes;
}

/** Whether a moment is inside quiet hours, which may wrap past midnight (22:00 to 07:00). */
export function inQuietHours(at: Date, start: string, end: string): boolean {
  const from = minutesOf(start);
  const to = minutesOf(end);
  if (from === null || to === null || from === to) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/**
 * Whether Ava may message the user first about this, now: the kind is switched on, and it is not quiet hours.
 * An approval goes through quiet hours: something he started is waiting for him.
 */
export function mayNotify(kind: NoticeKind, settings: WhatsAppRemoteSettings, at: Date): boolean {
  if (!settings.notify[kind]) return false;
  if (kind === 'approval') return true;
  return !inQuietHours(at, settings.quietStart, settings.quietEnd);
}
