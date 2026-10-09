import { calendarSettingsStore, upcomingEventsStore } from '@extension/storage';
import { createLogger } from '../log';
import { eventsBetween } from './ics';
import type { CalendarEvent } from './ics';

const logger = createLogger('Calendar');

export const CALENDAR_ALARM = 'calendar-check';
// The feed is read again this often; reminders are checked every minute
const REFRESH_MS = 10 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Reminders already given, kept in session storage so a restarted worker does not repeat them
const REMINDED_KEY = 'calendar-reminded';

/** A calendar title made safe to speak or show: one line, no quotes, at most 80 characters. */
export function quoteTitle(title: string): string {
  return title
    .replace(/[\r\n"“”]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export interface Reminder {
  event: CalendarEvent;
  minutes: number;
}

/**
 * Watches the user's calendar: reads its iCal feed every few minutes, keeps the next day's events
 * for the panel and for voice, and reminds the user shortly before each meeting.
 */
export class CalendarWatcher {
  private events: CalendarEvent[] = [];
  private readAt = 0;
  private readonly listeners = new Set<(reminder: Reminder) => void>();

  /** Called with each reminder, e.g. so voice can say it. */
  onReminder(listener: (reminder: Reminder) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    void chrome.alarms.create(CALENDAR_ALARM, { periodInMinutes: 1, delayInMinutes: 0.1 });
    chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === CALENDAR_ALARM) void this.tick().catch(error => logger.error('Calendar check failed', error));
    });
    chrome.notifications.onButtonClicked.addListener((id, button) => void this.onNotificationButton(id, button));
    chrome.notifications.onClicked.addListener(id => void this.onNotificationButton(id, 0));
  }

  /** Reads the feed now, whatever its schedule; returns an error message or null. */
  async refresh(): Promise<string | null> {
    const { icsUrl } = await calendarSettingsStore.getSettings();
    if (!icsUrl.trim()) {
      this.events = [];
      await upcomingEventsStore.set({ events: [], readAt: Date.now(), error: null });
      return null;
    }
    try {
      const url = icsUrl.trim().replace(/^webcal:/i, 'https:');
      // Plain http only for a calendar on this machine
      if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url)) {
        throw new Error('The calendar address must start with https:// or webcal://');
      }
      const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
      if (!response.ok) throw new Error(`The calendar answered ${response.status}`);
      const now = Date.now();
      this.events = eventsBetween(await response.text(), now - HOUR, now + 36 * HOUR);
      this.readAt = now;
      await upcomingEventsStore.set({
        events: this.events.map(({ id, title, start, end, joinUrl }) => ({ id, title, start, end, joinUrl })),
        readAt: now,
        error: null,
      });
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await upcomingEventsStore.set({ events: [], readAt: Date.now(), error: message });
      return message;
    }
  }

  /** Events from now on, soonest first. */
  async upcoming(hours = 24): Promise<CalendarEvent[]> {
    if (Date.now() - this.readAt > REFRESH_MS) await this.refresh();
    const now = Date.now();
    return this.events.filter(event => event.end > now && event.start < now + hours * HOUR);
  }

  private async tick(): Promise<void> {
    const settings = await calendarSettingsStore.getSettings();
    if (!settings.icsUrl.trim()) return;
    if (Date.now() - this.readAt > REFRESH_MS) await this.refresh();
    if (!settings.reminders) return;

    const now = Date.now();
    const reminded = new Set<string>(
      ((await chrome.storage.session.get(REMINDED_KEY))[REMINDED_KEY] as string[] | undefined) ?? [],
    );
    for (const event of this.events) {
      if (event.allDay || reminded.has(event.id)) continue;
      const until = event.start - now;
      if (until <= settings.remindMinutes * 60_000 && until > -60_000) {
        reminded.add(event.id);
        await this.remind({ event, minutes: Math.max(0, Math.round(until / 60_000)) });
      }
    }
    await chrome.storage.session.set({ [REMINDED_KEY]: [...reminded].slice(-200) });
  }

  private async remind(reminder: Reminder): Promise<void> {
    const { event, minutes } = reminder;
    const when = minutes <= 0 ? 'now' : `in ${minutes} min`;
    await chrome.notifications.create(`calendar:${event.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon-128.png'),
      title: `${event.title} — ${when}`,
      message: event.joinUrl ? 'Join it, then press Alt+Shift+M on the call to take notes.' : event.location || ' ',
      buttons: event.joinUrl ? [{ title: 'Join' }] : [],
      requireInteraction: true,
      priority: 2,
    });
    for (const listener of this.listeners) listener(reminder);
  }

  private async onNotificationButton(notificationId: string, button: number): Promise<void> {
    if (!notificationId.startsWith('calendar:') || button !== 0) return;
    const event = this.events.find(item => `calendar:${item.id}` === notificationId);
    if (event?.joinUrl) await chrome.tabs.create({ url: event.joinUrl, active: true });
    await chrome.notifications.clear(notificationId);
  }
}
