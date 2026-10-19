import { meetingSettingsStore, meetingStore, upcomingEventsStore } from '@extension/storage';
import type { UpcomingEvent } from '@extension/storage';
import { createLogger } from '../log';
import { deliverMeetingEvent } from './alerts';
import { isCallUrl } from './call-url';
import { CALL_DOM, readCallState } from './captions';
import type { CallState } from './captions';
import { leftCall } from './capture';
import { JoinFlow } from './join-flow';
import type { MeetingManager } from './manager';
import { platformOf } from './segments';

const logger = createLogger('AutoJoin');

export const AUTOJOIN_ALARM = 'meeting-autojoin';
const CANDIDATES_KEY = 'autojoin-candidates';
const DECLINED_KEY = 'autojoin-declined';
// How many checks in a row found the recorded call without its Leave button
const LEFT_KEY = 'autojoin-left-checks';
// A calendar event this close to now, without a matching link, is taken to be the call
const NEAR_MS = 15 * 60 * 1000;

export { isCallUrl };

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

async function sessionList(key: string): Promise<number[]> {
  return (((await chrome.storage.session.get(key))[key] as number[] | undefined) ?? []).slice(-50);
}

/** The user said this call is not one to take notes on. */
export async function declineCallTab(tabId: number): Promise<void> {
  const declined = await sessionList(DECLINED_KEY);
  if (!declined.includes(tabId)) await chrome.storage.session.set({ [DECLINED_KEY]: [...declined, tabId] });
}

/** The join flow wired to the real meeting manager, store, calendar and alerts. */
export function joinFlowFor(meetings: MeetingManager): JoinFlow {
  return new JoinFlow({
    start: tabId => meetings.start({ tabId, auto: true }),
    meeting: meetingId => meetingStore.get(meetingId),
    segmentCount: async meetingId => (await meetingStore.segments(meetingId)).length,
    chunkStats: async meetingId => {
      const chunks = await meetingStore.chunks(meetingId);
      return {
        total: chunks.length,
        troubled: chunks.filter(chunk => chunk.status === 'failed' || chunk.attempts > 0).length,
      };
    },
    setTopic: (meetingId, topic, source) => meetings.setTopic(meetingId, topic, source),
    addWarning: (meetingId, warning) => meetingStore.addWarning(meetingId, warning),
    calendarEvent: async url => matchEvent(url, (await upcomingEventsStore.get()).events ?? []),
    emit: deliverMeetingEvent,
    platformOf,
  });
}

/**
 * Starts meeting notes by itself when the user joins a call on Meet, Zoom or Teams, without asking
 * anything first. It records the tab's audio when Chrome allows it (the user invoked the extension on
 * the tab: the toolbar button or Alt+Shift+M), else reads the call's captions until the user does.
 * What the call is about is asked in the side panel and the Inbox, never in a window of its own, and
 * never before notes start. It also ends notes when the user leaves the call, and says so loudly when
 * nothing is being taken down.
 */
export class AutoJoin {
  readonly flow: JoinFlow;

  constructor(private readonly meetings: MeetingManager) {
    this.flow = joinFlowFor(meetings);
  }

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
    await declineCallTab(tabId);
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
    const settings = await meetingSettingsStore.getSettings();
    await this.watchRecording(settings.nothingCapturedSeconds).catch(error =>
      logger.warning('Could not check the meeting being recorded', error),
    );
    if (!settings.autoNotes) return;
    if ((await meetingStore.active()).some(meeting => meeting.status === 'recording')) return;
    const declined = new Set(await sessionList(DECLINED_KEY));
    for (const tabId of await sessionList(CANDIDATES_KEY)) {
      if (declined.has(tabId)) continue;
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (!tab?.url || !isCallUrl(tab.url)) {
        await this.forget(tabId);
        continue;
      }
      const [result] = await chrome.scripting
        .executeScript({ target: { tabId }, func: readCallState, args: [CALL_DOM, null] })
        .catch(() => []);
      if ((result?.result as CallState | undefined)?.inCall !== true) continue;
      await this.join(tabId, tab.url);
      return;
    }
  }

  /**
   * The meeting being recorded: keeps its captions on and its page watched, says so when nothing is
   * being caught, and ends it once the user has left the call (the tab moved off it, Meet shows its
   * "you left" screen, or the Leave button has been gone for three checks in a row). The page also says
   * at once when the user leaves (`meeting_call_left`); this check is for when that message was lost.
   */
  private async watchRecording(graceSeconds: number): Promise<void> {
    const recording = (await meetingStore.active()).find(meeting => meeting.status === 'recording');
    if (!recording) return;
    if (recording.tabId === null || !isCallUrl(recording.url)) {
      await this.flow.checkCapturing(recording.id, graceSeconds);
      return;
    }
    const tab = await chrome.tabs.get(recording.tabId).catch(() => undefined);
    if (!tab) return; // A closed tab ends the meeting on its own
    let left = !tab.url || !isCallUrl(tab.url);
    if (!left) {
      const state = await this.meetings.keepCapturing(recording.id);
      const misses =
        ((await chrome.storage.session.get(LEFT_KEY))[LEFT_KEY] as Record<string, number> | undefined) ?? {};
      const verdict = leftCall(state, misses[recording.id] ?? 0);
      await chrome.storage.session.set({ [LEFT_KEY]: { [recording.id]: verdict.misses } });
      left = verdict.left;
    }
    if (left) {
      logger.info('The user left the call; ending its notes');
      await this.meetings.stop(recording.id);
      return;
    }
    await this.flow.checkCapturing(recording.id, graceSeconds);
  }

  private async join(tabId: number, url: string): Promise<void> {
    try {
      // Tried once per call tab: a failure is said loudly, not retried every half minute
      await this.forget(tabId);
      const result = await this.flow.joined(tabId, url);
      if (result.ok) {
        const { nothingCapturedSeconds } = await meetingSettingsStore.getSettings();
        setTimeout(() => void this.check(), nothingCapturedSeconds * 1000 + 1000);
      }
    } catch (error) {
      logger.error('Could not start notes on the call', error);
    }
  }
}
