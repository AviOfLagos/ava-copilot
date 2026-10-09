import { meetingSettingsStore, meetingStore, upcomingEventsStore } from '@extension/storage';
import type { UpcomingEvent } from '@extension/storage';
import { createLogger } from '../log';
import type { MeetingManager } from './manager';

const logger = createLogger('AutoJoin');

export const AUTOJOIN_ALARM = 'meeting-autojoin';
const CANDIDATES_KEY = 'autojoin-candidates';
const DECLINED_KEY = 'autojoin-declined';
// A calendar event this close to now, without a matching link, is taken to be the call
const NEAR_MS = 15 * 60 * 1000;

/** Whether an address is a call itself, not a lobby or a home page. */
export function isCallUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname === 'meet.google.com') return /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(pathname);
    if (hostname === 'zoom.us' || hostname.endsWith('.zoom.us')) return /^\/wc\/(join\/)?\d+/.test(pathname);
    if (hostname === 'teams.microsoft.com' || hostname === 'teams.live.com') {
      return /meetup-join|light-meetings|\/meet\//.test(pathname + url);
    }
  } catch {
    // Not an address
  }
  return false;
}

/** The calendar event a call belongs to: the one with its link, else one starting about now. */
export function matchEvent(url: string, events: UpcomingEvent[], now = Date.now()): UpcomingEvent | null {
  const code = (() => {
    try {
      const { hostname, pathname } = new URL(url);
      if (hostname === 'meet.google.com') return pathname.split('/')[1]?.toLowerCase() ?? null;
      const zoom = /\/(?:wc\/(?:join\/)?|j\/)(\d+)/.exec(pathname);
      return zoom ? zoom[1] : null;
    } catch {
      return null;
    }
  })();
  if (code) {
    const linked = events.find(event => event.joinUrl?.toLowerCase().includes(code));
    if (linked) return linked;
  }
  const near = events
    .filter(event => Math.abs(event.start - now) <= NEAR_MS || (event.start <= now && event.end > now))
    .sort((a, b) => Math.abs(a.start - now) - Math.abs(b.start - now));
  // Two meetings at once is not a match: ask instead
  return near.length === 1 ? near[0] : null;
}

/** Runs in the meeting page: whether the user is in the call, judged by its Leave button. */
export const inCall = (): boolean => {
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
  return (
    !!document.querySelector('#hangup-button') ||
    buttons.some(button => /leave (call|meeting)|end call|hang up/i.test(button.getAttribute('aria-label') || ''))
  );
};

/** Runs in a Google Meet page: turns its captions on, which notes are taken from. */
export const turnOnMeetCaptions = (): boolean => {
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
  if (buttons.some(button => /turn off captions/i.test(button.getAttribute('aria-label') || ''))) return true;
  const on = buttons.find(button => /turn on captions/i.test(button.getAttribute('aria-label') || ''));
  on?.click();
  return !!on;
};

async function sessionList(key: string): Promise<number[]> {
  return (((await chrome.storage.session.get(key))[key] as number[] | undefined) ?? []).slice(-50);
}

/**
 * Starts meeting notes by itself when the user joins a call on Meet, Zoom or Teams, from the
 * meeting's captions (Chrome only gives tab audio after the user invokes the extension on the tab;
 * Alt+Shift+M adds it). When the calendar does not say what the call is, a small window asks.
 */
export class AutoJoin {
  constructor(private readonly meetings: MeetingManager) {}

  start(): void {
    void chrome.alarms.create(AUTOJOIN_ALARM, { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === AUTOJOIN_ALARM) void this.check();
    });
    chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
      if (info.status === 'complete' && tab.url && isCallUrl(tab.url)) void this.watch(tabId);
    });
    chrome.tabs.onRemoved.addListener(tabId => void this.forget(tabId));
  }

  /** The user said this call is not one to take notes on. */
  async decline(tabId: number): Promise<void> {
    const declined = await sessionList(DECLINED_KEY);
    await chrome.storage.session.set({ [DECLINED_KEY]: [...declined, tabId] });
  }

  private async watch(tabId: number): Promise<void> {
    const candidates = await sessionList(CANDIDATES_KEY);
    if (!candidates.includes(tabId)) await chrome.storage.session.set({ [CANDIDATES_KEY]: [...candidates, tabId] });
    // The Leave button shows a few seconds after the call opens
    setTimeout(() => void this.check(), 6000);
  }

  private async forget(tabId: number): Promise<void> {
    const candidates = await sessionList(CANDIDATES_KEY);
    await chrome.storage.session.set({ [CANDIDATES_KEY]: candidates.filter(id => id !== tabId) });
  }

  private async check(): Promise<void> {
    const { autoNotes } = await meetingSettingsStore.getSettings();
    if (!autoNotes) return;
    if ((await meetingStore.active()).some(meeting => meeting.status === 'recording')) return;
    const declined = new Set(await sessionList(DECLINED_KEY));
    for (const tabId of await sessionList(CANDIDATES_KEY)) {
      if (declined.has(tabId)) continue;
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (!tab?.url || !isCallUrl(tab.url)) {
        await this.forget(tabId);
        continue;
      }
      const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: inCall }).catch(() => []);
      if (result?.result !== true) continue;
      await this.join(tabId, tab.url);
      return;
    }
  }

  private async join(tabId: number, url: string): Promise<void> {
    try {
      if (new URL(url).hostname === 'meet.google.com') {
        await chrome.scripting.executeScript({ target: { tabId }, func: turnOnMeetCaptions }).catch(() => []);
      }
      const meetingId = await this.meetings.start({ tabId, auto: true });
      await this.forget(tabId);
      const { events } = await upcomingEventsStore.get();
      const event = matchEvent(url, events ?? []);
      if (event) {
        await this.meetings.setTopic(meetingId, event.title, 'calendar');
        await chrome.notifications.create(`autojoin:${meetingId}`, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icon-128.png'),
          title: 'Taking notes on this call',
          message: 'From the call’s captions. Press Alt+Shift+M on the call to add its audio.',
          priority: 1,
        });
      } else {
        await this.ask(meetingId);
      }
    } catch (error) {
      logger.error('Could not start notes on the call', error);
    }
  }

  /** A small window asking what the call is about, with the day's calendar as quick answers. */
  private async ask(meetingId: string): Promise<void> {
    const display = await chrome.windows.getLastFocused().catch(() => undefined);
    const width = 380;
    await chrome.windows.create({
      url: chrome.runtime.getURL(`meeting-ask.html?meeting=${encodeURIComponent(meetingId)}`),
      type: 'popup',
      width,
      height: 340,
      left: display?.left !== undefined && display.width ? display.left + display.width - width - 24 : undefined,
      top: display?.top !== undefined ? display.top + 80 : undefined,
      focused: true,
    });
  }
}
