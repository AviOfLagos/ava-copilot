import { inboxSettingsStore } from '@extension/storage';
import type { InboxItem } from '@extension/storage';
import { services } from '../registry/services';
import { speak } from '../tts/speak';
import type { Reminder } from '../calendar/watcher';
import { ANNOUNCE_MIN_GAP_MS } from './constants';

/**
 * Turns a high-priority item, an approval, or a meeting about to start into one short spoken line:
 * the Live conversation says it when it is on, a local/system voice otherwise (`speak.ts`). Gated by
 * "Speak up when something needs me", quiet hours and a minimum gap, so it never talks over itself.
 * Never reads a message's body aloud: only a title (a sender name, a short label) or a plain fact.
 */

export interface QuietHours {
  start: string | null;
  end: string | null;
}

/** "HH:MM" to minutes since midnight, or null when empty or not well formed. */
function minutesOf(time: string | null): number | null {
  if (!time) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Whether a moment falls inside quiet hours, which may wrap past midnight (e.g. 22:00 to 07:00). */
export function withinQuietHours(at: Date, quiet: QuietHours): boolean {
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === null || end === null || start === end) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export interface AnnounceDecisionInput {
  enabled: boolean;
  quiet: QuietHours;
  lastAnnouncedAt: number;
  now: number;
  minGapMs?: number;
}

/** Whether an announcement may be spoken right now: the setting, quiet hours, then the minimum gap. */
export function shouldAnnounce(input: AnnounceDecisionInput): boolean {
  if (!input.enabled) return false;
  if (withinQuietHours(new Date(input.now), input.quiet)) return false;
  return input.now - input.lastAnnouncedAt >= (input.minGapMs ?? ANNOUNCE_MIN_GAP_MS);
}

function sourceLabel(source: string): string {
  if (source === 'whatsapp-web') return 'WhatsApp';
  if (source === 'slack-web') return 'Slack';
  if (source === 'gmail-web') return 'Gmail';
  if (source.startsWith('workflow:')) return 'a routine';
  if (source.startsWith('agent:')) return 'an agent';
  return source;
}

/** The line spoken for an item. `item.title` is a sender name or a short label, never the message body. */
export function lineForItem(item: InboxItem): string {
  if (item.kind === 'approval') return `You have an approval waiting: ${item.title}.`;
  if (item.digestCount) return `${item.title}, from ${sourceLabel(item.source)}.`;
  return `A new message from ${item.title}.`;
}

/** The line spoken for a calendar reminder. Never the meeting's title: an invite is anyone's words. */
export function lineForReminder(reminder: Reminder): string {
  return `Your meeting starts ${reminder.minutes <= 0 ? 'now' : `in ${reminder.minutes} minutes`}.`;
}

const SESSION_KEY = 'inbox-last-announced';

async function lastAnnouncedAt(): Promise<number> {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return typeof stored[SESSION_KEY] === 'number' ? stored[SESSION_KEY] : 0;
}

async function markAnnounced(now: number): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEY]: now });
}

/** Speaks now: through the Live conversation when one is on, else the configured TTS engine. */
async function speakLine(text: string): Promise<void> {
  if (services().voice.running) {
    await services().voice.announce(text);
    return;
  }
  await speak(text, { threadId: 'inbox', messageId: `inbox-announce-${Date.now()}` });
}

async function maybeAnnounce(line: string, now: number = Date.now()): Promise<void> {
  const settings = await inboxSettingsStore.getSettings();
  const ok = shouldAnnounce({
    enabled: settings.speakUp,
    quiet: { start: settings.quietHoursStart, end: settings.quietHoursEnd },
    lastAnnouncedAt: await lastAnnouncedAt(),
    now,
  });
  if (!ok) return;
  await markAnnounced(now);
  await speakLine(line);
}

/** Called when a new item lands; speaks up only for what is worth interrupting for. */
export async function announceItem(item: InboxItem): Promise<void> {
  if (item.priority !== 'high' && item.kind !== 'approval') return;
  await maybeAnnounce(lineForItem(item));
}

/** Called on every calendar reminder. Skipped while Live is on: it already announces this itself. */
export async function announceMeetingSoon(reminder: Reminder): Promise<void> {
  if (services().voice.running) return;
  await maybeAnnounce(lineForReminder(reminder));
}
