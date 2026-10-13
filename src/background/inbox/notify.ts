import type { InboxItem } from '@extension/storage';
import { NOTIFY_MIN_GAP_MS } from './constants';

/** Whether a desktop notification may fire now, given when the last one went out. */
export function shouldNotify(lastAt: number, now: number, minGapMs: number = NOTIFY_MIN_GAP_MS): boolean {
  return now - lastAt >= minGapMs;
}

const SESSION_KEY = 'inbox-last-notified';

async function lastNotifiedAt(): Promise<number> {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return typeof stored[SESSION_KEY] === 'number' ? stored[SESSION_KEY] : 0;
}

/**
 * A desktop notification for a high-priority item, throttled so a burst never raises more than one
 * every couple of minutes. The body is the item's title only (never the untrusted message body).
 */
export async function notifyHighPriority(item: InboxItem, now: number = Date.now()): Promise<void> {
  if (item.priority !== 'high') return;
  if (!(await shouldNotify(await lastNotifiedAt(), now))) return;
  await chrome.storage.session.set({ [SESSION_KEY]: now });
  await chrome.notifications
    .create(`inbox:${item.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon-128.png'),
      title: 'Nex Copilot',
      message: item.title.slice(0, 200),
      priority: 1,
    })
    .catch(() => {});
}
