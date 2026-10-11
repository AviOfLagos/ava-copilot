import { t } from '@extension/i18n';
import {
  briefSettingsStore,
  db,
  generalSettingsStore,
  graphStore,
  localDay,
  threadStore,
  usageStore,
  workspaceStore,
} from '@extension/storage';
import { wrapUntrustedContent } from '../agent/messages/utils';
import type { CalendarWatcher } from '../calendar/watcher';
import { generatePlainText } from '../llm/generate';
import { systemMessage, userMessage } from '../llm/messages';
import { createLogger } from '../log';
import { resolveModels } from '../threads/factory';
import { isOverCap } from '../usage/budget';
import { briefDue, briefMarkdown, localDate, PRIORITIES_INSTRUCTIONS, priorityLines, todaysEvents } from './brief';
import type { BriefData } from './brief';

const logger = createLogger('MorningBrief');

export const BRIEF_ALARM = 'morning-brief';
const NOTIFICATION_ID = 'morning-brief';
// The panel opens this chat the next time it opens, e.g. after the notification is clicked
export const OPEN_THREAD_KEY = 'open-thread';
const BRIEF_SESSION = 'morning-brief';

/**
 * The morning brief: once a day, at the user's time or the first moment after it that the browser is
 * up, a chat with today's calendar, what waits on the user, each workspace's open actions and recent
 * decisions, and up to three priorities a model picks from them.
 */
export class MorningBrief {
  private making: Promise<string> | null = null;

  constructor(private readonly calendar: CalendarWatcher) {}

  start(): void {
    void chrome.alarms.create(BRIEF_ALARM, { periodInMinutes: 15 });
    chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === BRIEF_ALARM) void this.check();
    });
    chrome.runtime.onStartup.addListener(() => void this.check());
    chrome.notifications.onClicked.addListener(id => {
      if (id === NOTIFICATION_ID) void this.open();
    });
    // Settings asks for one now
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id || message?.type !== 'brief_make') return;
      this.make({ notify: false })
        .then(async () => sendResponse({ threadId: (await briefSettingsStore.getSettings()).lastThreadId }))
        .catch(error => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
      return true;
    });
    // A minute after starting: the calendar and the models are ready by then
    setTimeout(() => void this.check(), 60_000);
  }

  /** Makes today's brief when it is due. */
  async check(): Promise<void> {
    if (briefDue(await briefSettingsStore.getSettings())) {
      await this.make().catch(error => logger.error('The morning brief failed', error));
    }
  }

  /** Today's brief: the one made already, or a new one. Returns its text. */
  async today(): Promise<string> {
    const settings = await briefSettingsStore.getSettings();
    if (settings.lastDay === localDate(Date.now()) && settings.lastThreadId) {
      const [message] = (await threadStore.messages(settings.lastThreadId)).filter(item => item.actor === 'planner');
      if (message) return message.content;
    }
    return this.make({ notify: false });
  }

  /** Makes a brief now, saves it as a chat, and tells the user. One at a time. */
  make({ notify = true }: { notify?: boolean } = {}): Promise<string> {
    this.making ??= this.build(notify).finally(() => {
      this.making = null;
    });
    return this.making;
  }

  private async build(notify: boolean): Promise<string> {
    const now = Date.now();
    const nodes = await graphStore.nodes();
    const threads = await db.threads.toArray();
    const data: BriefData = {
      now,
      events: await this.calendar.upcoming(24).catch(() => []),
      actions: nodes.filter(node => node.type === 'action'),
      decisions: nodes.filter(node => node.type === 'decision'),
      waiting: threads.filter(thread => thread.status === 'waiting_confirm'),
      stopped: threads.filter(
        thread => thread.status === 'error' && !thread.archived && now - thread.updatedAt < 86_400_000,
      ),
      workspaces: await workspaceStore.list(),
    };

    let priorities: string[] = [];
    if (!(await this.overCap())) {
      try {
        const { planner } = await resolveModels(null, { sessionId: BRIEF_SESSION, notify: () => {} });
        const answer = await generatePlainText({
          chatModel: planner,
          messages: [
            systemMessage(PRIORITIES_INSTRUCTIONS),
            // Invite titles, chats and pages say what they like: data, never instructions
            userMessage(wrapUntrustedContent(briefMarkdown(data))),
          ],
        });
        priorities = priorityLines(answer);
      } catch (error) {
        // The brief still comes, without priorities
        logger.warning('Could not pick the priorities', error);
      }
    }

    const text = briefMarkdown(data, priorities);
    const day = new Date(now).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    const thread = await threadStore.create({ title: t('brief_title', [day]), tags: ['brief'] });
    await threadStore.addMessage(thread.id, 'planner', text);
    await briefSettingsStore.updateSettings({ lastDay: localDate(now), lastThreadId: thread.id });

    if (notify) {
      // Counts only: invite titles are written by whoever sent them
      const meetings = todaysEvents(data.events, now).length;
      await chrome.notifications
        .create(NOTIFICATION_ID, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icon-128.png'),
          title: t('brief_ready'),
          message: t('brief_counts', [String(meetings), String(data.waiting.length + data.stopped.length)]),
          priority: 1,
        })
        .catch(() => {});
    }
    return text;
  }

  /** Opens the latest brief in the side panel, or has the panel open it next. */
  private async open(): Promise<void> {
    const { lastThreadId } = await briefSettingsStore.getSettings();
    if (!lastThreadId) return;
    await chrome.storage.session.set({ [OPEN_THREAD_KEY]: lastThreadId });
    const window = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
    if (window?.id !== undefined) await chrome.sidePanel.open({ windowId: window.id }).catch(() => {});
  }

  private async overCap(): Promise<boolean> {
    const { dailyCostCapUsd } = await generalSettingsStore.getSettings();
    return isOverCap((await usageStore.getDay(localDay())).costUsd, dailyCostCapUsd);
  }
}
