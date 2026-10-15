import { meetingSettingsStore, meetingStore } from '@extension/storage';
import { createLogger } from '../log';
import { meetJoin } from '../meetings/call-control';
import { services } from '../registry/services';
import type { StepExecutor } from './engine';
import { browserJoinUrl, findMeetingLink, meetingKindOf, parseTabDetail } from './tab-trigger';

/** The meeting-links routine's step, `step.meeting_join` (see ./tab-trigger.ts for the trigger). */

const logger = createLogger('MeetingJoin');

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The step that joins: it runs only after the user's click (it is a side effect), on the tab the trigger saw. A
 * calendar event's own meeting link is opened first; Meet's Join button is pressed; notes start on their own (the
 * auto-notes setting) or are started here.
 */
export function meetingJoinExecutor(): StepExecutor {
  return {
    retry: null,
    taints: false,
    async execute({ run }) {
      const target = parseTabDetail(run.trigger.detail);
      if (!target) return { kind: 'done', output: { joined: false, reason: 'This run did not come from a tab.' } };
      let url = target.url;
      let tab = await chrome.tabs.get(target.tabId).catch(() => undefined);
      if (meetingKindOf(url) === 'calendar') {
        const [found] = tab?.id
          ? await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: findMeetingLink }).catch(() => [])
          : [];
        const link = typeof found?.result === 'string' ? found.result : null;
        if (!link) return { kind: 'done', output: { joined: false, reason: 'The event has no meeting link.' } };
        url = link;
        tab = await chrome.tabs.create({ url: browserJoinUrl(url), active: true, windowId: tab?.windowId });
      } else if (!tab?.id) {
        tab = await chrome.tabs.create({ url: browserJoinUrl(url), active: true });
      } else if (browserJoinUrl(url) !== url) {
        await chrome.tabs.update(tab.id, { url: browserJoinUrl(url) });
      }
      if (!tab?.id) return { kind: 'done', output: { joined: false, reason: 'The meeting tab is gone.' } };
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});

      let joined = false;
      if (meetingKindOf(url) === 'meet') {
        for (let i = 0; i < 20 && !joined; i++) {
          await sleep(1000);
          const [result] = await chrome.scripting
            .executeScript({ target: { tabId: tab.id }, func: meetJoin })
            .catch(() => []);
          joined = result?.result === true;
        }
      }
      const notes = await startNotes(tab.id);
      return { kind: 'done', output: { joined, url: browserJoinUrl(url), notes } };
    },
  };
}

/** Notes for the meeting tab: the auto-notes setting takes them once the user is in; otherwise they start here. */
async function startNotes(tabId: number): Promise<string> {
  if ((await meetingSettingsStore.getSettings()).autoNotes) return 'start on their own once you are in';
  await sleep(3000);
  if ((await meetingStore.active()).some(meeting => meeting.status === 'recording')) return 'already being taken';
  try {
    await services().meetings.start({ tabId, auto: true });
    return 'started';
  } catch (error) {
    logger.info('Notes did not start', error);
    return `not started: ${error instanceof Error ? error.message : String(error)}`;
  }
}
