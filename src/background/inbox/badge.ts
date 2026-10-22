import { db as defaultDb } from '@extension/storage';
import type { AviCopilotDb } from '@extension/storage';
import { setupStore } from '../setup/state';
import { unreadCount } from './store';

/**
 * The toolbar badge, shared with meeting notes. Meetings only ever call `chrome.action.setBadgeText`
 * with a `tabId` (a per-tab "REC" override), never the global default, so this only ever touches the
 * default badge shown everywhere else: the two never collide. While any meeting records, this skips
 * the update instead of writing the global badge, so a REC badge is never raced by an unread count
 * landing at the same moment; the next change (a meeting ending, a new item) corrects it. With nothing unread, the
 * badge counts the setup steps still owed (Settings › General › Setup), and goes away when they are done.
 */

const BADGE_COLOR = '#3b7a57';
// Setup still owed (src/background/setup): shown only while the Inbox has nothing unread, in a quieter colour
const SETUP_BADGE_COLOR = '#5b6475';

/** The badge text for a count: nothing when zero, the number, capped so it still fits. */
export function badgeText(count: number): string {
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}

export async function refreshBadge(database: AviCopilotDb = defaultDb): Promise<void> {
  const recording = await database.meetings.where('status').equals('recording').count();
  if (recording > 0) return;
  const count = await unreadCount(database);
  const setup =
    count > 0
      ? 0
      : await setupStore.getState().then(
          state => state.pending,
          () => 0,
        );
  const text = badgeText(count || setup);
  await chrome.action.setBadgeText({ text }).catch(() => {});
  if (text) {
    await chrome.action.setBadgeBackgroundColor({ color: count ? BADGE_COLOR : SETUP_BADGE_COLOR }).catch(() => {});
  }
}
