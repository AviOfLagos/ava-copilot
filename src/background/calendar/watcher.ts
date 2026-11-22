import { calendarSettingsStore, upcomingEventsStore } from '@extension/storage';
import type { CalendarSettingsConfig, CalendarSourceName, UpcomingEvent } from '@extension/storage';
import { companionClient } from '../companion/client';
import { brainSettingsStore } from '../companion/state';
import { createLogger } from '../log';
import { learnFromCalendar } from '../people/calendar';
import type { CalendarEvent } from './ics';
import { icsSource, macSource, planSources, readFromSources } from './sources';
import type { CalendarSource } from './sources';

const logger = createLogger('Calendar');

export const CALENDAR_ALARM = 'calendar-check';
// The feed is read again this often; reminders are checked every minute
const REFRESH_MS = 10 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Reminders already given, kept in session storage so a restarted worker does not repeat them
const REMINDED_KEY = 'calendar-reminded';
// Said at most this often: Ava Brain cannot read the Mac's Calendar until it is allowed again
export const CALENDAR_ACCESS_NOTICE = 'calendar-access';
const ACCESS_NOTICE_KEY = 'calendar-access-noticed';
const ACCESS_NOTICE_EVERY_MS = 6 * HOUR;

/** A calendar title made safe to speak or show: one line, no quotes, at most 80 characters. */
export function quoteTitle(title: string): string {
  return title
    .replace(/[\r\n"“”]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * What was read from the calendar and how far it can be trusted. 'not_connected': no calendar is set up, so
 * no events means nothing. 'failed': the last read did not work; the events are the ones from the last read
 * that did (`asOf`), if there was one.
 */
export interface CalendarReading {
  state: 'read' | 'not_connected' | 'failed';
  events: CalendarEvent[];
  error: string | null;
  asOf: number | null;
}

const toStored = (events: CalendarEvent[]): UpcomingEvent[] =>
  events.map(({ id, title, start, end, joinUrl, allDay, location, attendees, organizer }) => ({
    id,
    title,
    start,
    end,
    joinUrl,
    allDay,
    location,
    ...(attendees?.length ? { attendees } : {}),
    ...(organizer ? { organizer } : {}),
  }));

export interface Reminder {
  event: CalendarEvent;
  minutes: number;
}

/**
 * Watches the user's calendar: reads it every few minutes (the Mac's Calendar through Ava Brain, or the iCal
 * address; see ./sources.ts), keeps the next day's events
 * for the panel and for voice, and reminds the user shortly before each meeting.
 */
export class CalendarWatcher {
  private events: CalendarEvent[] = [];
  private readAt = 0;
  // When the events were last read without an error, across restarts
  private okAt: number | null = null;
  private hydrating: Promise<void> | null = null;

  /**
   * Starts from what was stored: a background that restarted (it does, every few minutes when idle) knows the
   * day it last read, instead of an empty one that a failed read would then write over the stored events.
   */
  private hydrate(): Promise<void> {
    this.hydrating ??= (async () => {
      const stored = await upcomingEventsStore.get().catch(() => null);
      if (!stored || this.readAt > 0) return;
      this.events = (stored.events ?? []).map(event => ({ allDay: false, location: '', ...event }));
      this.source = stored.source ?? null;
      // Only a read that came from a calendar counts: with none connected, "no error" was stored too
      this.okAt = stored.okAt ?? (stored.error === null && stored.readAt > 0 && stored.source ? stored.readAt : null);
    })();
    return this.hydrating;
  }
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

  /** The sources to read, in order: the Mac's Calendar when Ava Brain is paired, then the iCal address. */
  private async sources(settings: CalendarSettingsConfig): Promise<CalendarSource[]> {
    const paired = (await brainSettingsStore.getSettings().catch(() => ({ paired: false }))).paired;
    return planSources({ paired, settings }).map(name =>
      name === 'mac' ? macSource(companionClient, settings.macCalendarIds) : icsSource(settings.icsUrl),
    );
  }

  /** Where the events were read from last time, for the panel. */
  source: CalendarSourceName | null = null;

  /** Reads the calendar now, whatever its schedule; returns an error message or null. */
  async refresh(): Promise<string | null> {
    await this.hydrate();
    const settings = await calendarSettingsStore.getSettings();
    const sources = await this.sources(settings);
    const now = Date.now();
    if (!sources.length) {
      this.events = [];
      this.source = null;
      this.okAt = null;
      await upcomingEventsStore.set({ events: [], readAt: now, error: null, source: null });
      return null;
    }
    const read = await readFromSources(sources, now - HOUR, now + 36 * HOUR);
    if (read.macNeedsAccess) await this.noticeAccess(now);
    if (read.error !== null) {
      // Kept as they were: one failed read does not empty the day
      await upcomingEventsStore.set({
        events: toStored(this.events),
        readAt: now,
        error: read.error,
        source: this.source,
        ...(this.okAt !== null ? { okAt: this.okAt } : {}),
      });
      return read.error;
    }
    this.events = read.events;
    this.source = read.source;
    // Invitees' names and addresses are learned (on this computer only); a failure never stops the calendar
    void learnFromCalendar(read.events).catch(error => logger.warning('Could not learn invitees', error));
    this.readAt = now;
    this.okAt = now;
    await upcomingEventsStore.set({
      events: toStored(this.events),
      readAt: now,
      error: null,
      source: read.source,
      okAt: now,
    });
    return null;
  }

  /**
   * The coming events with how far they can be trusted, for the morning brief: a calendar that is not connected
   * or could not be read is said, never shown as "nothing on today".
   */
  async reading(hours = 24): Promise<CalendarReading> {
    const settings = await calendarSettingsStore.getSettings();
    const paired = (await brainSettingsStore.getSettings().catch(() => ({ paired: false }))).paired;
    // The Mac's Calendar with no calendar ticked reads as empty without an error: that is not a connected calendar
    const usable = planSources({ paired, settings }).filter(
      name => !(name === 'mac' && settings.macCalendarIds?.length === 0),
    );
    if (!usable.length) {
      return { state: 'not_connected', events: [], error: null, asOf: null };
    }
    await this.hydrate();
    const error = Date.now() - this.readAt > REFRESH_MS ? await this.refresh() : null;
    const now = Date.now();
    return {
      state: error === null ? 'read' : 'failed',
      events: this.events.filter(event => event.end > now && event.start < now + hours * HOUR),
      error,
      asOf: this.okAt,
    };
  }

  /** Events from now on, soonest first. */
  async upcoming(hours = 24): Promise<CalendarEvent[]> {
    await this.hydrate();
    if (Date.now() - this.readAt > REFRESH_MS) await this.refresh();
    const now = Date.now();
    return this.events.filter(event => event.end > now && event.start < now + hours * HOUR);
  }

  private async tick(): Promise<void> {
    const settings = await calendarSettingsStore.getSettings();
    if (!(await this.sources(settings)).length) return;
    await this.hydrate();
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

  /**
   * Ava Brain lost Calendar permission (macOS asks again when the program it runs as changes, e.g. a Node update):
   * one notice, whose button shows the macOS prompt on the Mac.
   */
  private async noticeAccess(now: number): Promise<void> {
    const last = ((await chrome.storage.local.get(ACCESS_NOTICE_KEY))[ACCESS_NOTICE_KEY] as number | undefined) ?? 0;
    if (now - last < ACCESS_NOTICE_EVERY_MS) return;
    await chrome.storage.local.set({ [ACCESS_NOTICE_KEY]: now });
    await chrome.notifications.create(CALENDAR_ACCESS_NOTICE, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon-128.png'),
      title: 'Ava can’t read your Calendar',
      message:
        'macOS took back Ava Brain’s Calendar permission (it asks again when Ava Brain’s program changes, e.g. after ' +
        'a Node update). Press Allow on the Mac, then choose Allow in the macOS prompt.',
      buttons: [{ title: 'Allow on the Mac' }],
      priority: 1,
    });
  }

  private async allowAccess(): Promise<void> {
    await chrome.notifications.clear(CALENDAR_ACCESS_NOTICE);
    const { access } = await companionClient.calendarRequestAccess();
    if (access === 'granted') {
      await chrome.storage.local.remove(ACCESS_NOTICE_KEY);
      await this.refresh();
    }
  }

  private async onNotificationButton(notificationId: string, button: number): Promise<void> {
    if (notificationId === CALENDAR_ACCESS_NOTICE && button === 0) {
      return void (await this.allowAccess().catch(error => logger.warning('Allowing Calendar', error)));
    }
    if (!notificationId.startsWith('calendar:') || button !== 0) return;
    await this.hydrate();
    const event = this.events.find(item => `calendar:${item.id}` === notificationId);
    if (event?.joinUrl) await chrome.tabs.create({ url: event.joinUrl, active: true });
    await chrome.notifications.clear(notificationId);
  }
}
