import { db as defaultDb } from '@extension/storage';
import type { AviCopilotDb } from '@extension/storage';
import { unreadCount } from './store';

/**
 * The toolbar badge, shared with meeting notes. Meetings only ever call `chrome.action.setBadgeText`
 * with a `tabId` (a per-tab "REC" override), never the global default, so this only ever touches the
 * default badge shown everywhere else: the two never collide. While any meeting records, this skips
 * the update instead of writing the global badge, so a REC badge is never raced by an unread count
 * landing at the same moment; the next change (a meeting ending, a new item) corrects it.
 */

const BADGE_COLOR = '#3b7a57';

/** The badge text for a count: nothing when zero, the number, capped so it still fits. */
export function badgeText(count: number): string {
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}

export async function refreshBadge(database: AviCopilotDb = defaultDb): Promise<void> {
  const recording = await database.meetings.where('status').equals('recording').count();
  if (recording > 0) return;
  const count = await unreadCount(database);
  const text = badgeText(count);
  await chrome.action.setBadgeText({ text }).catch(() => {});
  if (text) await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR }).catch(() => {});
}
