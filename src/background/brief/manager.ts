import { t } from '@extension/i18n';
import {
  briefSettingsStore,
  db,
  graphStore,
  personalityStore,
  stripTaskMarkers,
  taskStore,
  threadStore,
  workspaceStore,
} from '@extension/storage';
import { wrapUntrustedContent } from '../agent/messages/utils';
import type { CalendarWatcher } from '../calendar/watcher';
import { generatePlainText } from '../llm/generate';
import { systemMessage, userMessage } from '../llm/messages';
import { createLogger } from '../log';
import { emitNotice } from '../notices';
import { resolveModels } from '../threads/factory';
import { isOverDailyBudget } from '../usage/budget';
import { briefSectionsPending, sectionMarkdown, todaysBriefSections } from '../workflows/brief';
import type { WorkflowBriefSection } from '../workflows/brief';
import { briefExtraSections, briefExtrasPending } from './extras';
import { rollupMarkdown, workspaceSummaries } from '../history/summaries';
import {
  briefDue,
  briefLine,
  briefMarkdown,
  briefTaskIds,
  localDate,
  PRIORITIES_INSTRUCTIONS,
  priorityLines,
  sourcesLine,
  stoppedThreads,
} from './brief';
import type { BriefData, BriefSource, SourceState, WaitingRun } from './brief';
import type { InboxItem } from '@extension/storage';
import { toneLine } from '../personalities/prompt';
import { loadIdentityContext } from '../identity/context';
import { briefContext, goalLines } from '../identity/prompt';

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

  /**
   * Makes today's brief when it is due. A workflow that feeds the brief and runs or is due right now goes
   * first: the brief comes when it ends (the workflow asks for it then).
   */
  async check(): Promise<void> {
    if (briefDue(await briefSettingsStore.getSettings())) {
      if (await briefSectionsPending(db, Date.now()).catch(() => false)) return;
      // A section another feature is still making (the growth team's standup): the brief comes when it ends
      if (await briefExtrasPending(Date.now())) return;
      await this.make().catch(error => logger.error('The morning brief failed', error));
    }
  }

  /** Today's brief: the one made already, with the sections added since, or a new one. Returns its text. */
  async today(): Promise<string> {
    const settings = await briefSettingsStore.getSettings();
    if (settings.lastDay === localDate(Date.now()) && settings.lastThreadId) {
      const said = (await threadStore.messages(settings.lastThreadId)).filter(item => item.actor === 'planner');
      // Said out loud or handed to a model: the words only, without the checkboxes' markers
      if (said.length) return stripTaskMarkers(said.map(message => message.content).join('\n\n'));
    }
    return stripTaskMarkers(await this.make({ notify: false }));
  }

  /**
   * A section a workflow made after today's brief: added to the brief's chat, once. Returns false when today's
   * brief is not made yet; it will include the section when it is.
   */
  async addSection(section: WorkflowBriefSection): Promise<boolean> {
    // A brief being made may have read its sources before this section existed: add to it once it is saved
    if (this.making) await this.making.catch(() => undefined);
    const settings = await briefSettingsStore.getSettings();
    if (settings.lastDay !== localDate(Date.now()) || !settings.lastThreadId) return false;
    const text = sectionMarkdown(section);
    const said = await threadStore.messages(settings.lastThreadId);
    if (said.some(message => message.content.includes(text))) return true;
    await threadStore.addMessage(settings.lastThreadId, 'planner', text);
    return true;
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
    // Every source is read on its own, and one that cannot be read is named in the brief: a failed read never
    // turns into "nothing" (docs/growth-team.md, Part 5a)
    const sources: BriefSource[] = [];
    const read = async <T>(name: string, load: () => Promise<T>, empty: T): Promise<T> => {
      try {
        const value = await load();
        sources.push({ name, state: 'read' });
        return value;
      } catch (error) {
        logger.warning(`The brief could not read ${name}`, error);
        sources.push({ name, state: 'failed' });
        return empty;
      }
    };

    // The calendar says itself whether it is connected and whether its last read worked
    const calendarName = t('brief_source_calendar');
    const calendar = await this.calendar
      .reading(24)
      .catch(error => ({ state: 'failed' as const, events: [], error: String(error), asOf: null }));
    sources.push({ name: calendarName, state: calendar.state });
    const calendarNote =
      calendar.state === 'not_connected'
        ? t('brief_calendar_notConnected')
        : calendar.state === 'failed'
          ? // "What it showed at …" only with something to show: an empty list under it would read as a free day
            calendar.asOf && calendar.events.length > 0
            ? t('brief_calendar_failedAsOf', [asOfText(calendar.asOf, now)])
            : t('brief_calendar_failed')
          : undefined;

    const threads = await read(t('brief_source_chats'), () => db.threads.toArray(), []);
    const chatIds = new Set(threads.map(thread => thread.id));
    // An item that points at a chat since deleted waits on nothing
    const inbox = (await read(t('brief_source_inbox'), () => inboxDecisions(), [])).filter(item => {
      const chat = item.approval?.requestId.startsWith('thread:') ? item.approval.requestId.slice(7) : null;
      return chat === null || chatIds.has(chat);
    });
    // Agents and their waiting runs are one source: either both were read or the brief says they were not
    const { agents, runs } = await read(
      t('brief_source_agents'),
      async () => ({ agents: await db.agents.toArray(), runs: await waitingRuns() }),
      { agents: [], runs: [] },
    );
    const nodes = await read(t('brief_source_knowledge'), () => graphStore.nodes(), []);
    // The task board: one list per workspace (docs/pm-desk.md, Part 2.5)
    const tasks = await read(t('brief_source_tasks'), () => taskStore.list({ status: 'open' }), []);
    // Who the brief is for and what they are working towards (all workspaces: the brief covers every one)
    const identity = await loadIdentityContext(null);
    const data: BriefData = {
      now,
      events: calendar.events,
      calendarNote,
      tasks,
      decisions: nodes.filter(node => node.type === 'decision'),
      waiting: threads.filter(thread => thread.status === 'waiting_confirm' && !thread.archived),
      stopped: stoppedThreads(threads, now),
      inbox,
      runs,
      agentNames: Object.fromEntries(agents.map(agent => [agent.id, agent.name])),
      sourcesLine: sourcesLine(sources, t),
      workspaces: await workspaceStore.list(),
      // What workflows gathered for the brief today
      sections: [
        ...(await todaysBriefSections(db, now).catch(() => [])),
        // Sections other features add (the growth team's Team section)
        ...(await briefExtraSections(now)).map(section => ({
          workflowId: section.id,
          workflowName: section.title,
          title: section.title,
          markdown: section.markdown,
          workspaceId: section.workspaceId,
          at: now,
        })),
      ],
      // Where each workspace is at, from its summary (imported AI sessions, chats, meetings, notes)
      rollup: await workspaceSummaries
        .refresh()
        .catch(() => [])
        .then(() => workspaceSummaries.rollup(now))
        // Without tasks: the brief lists them once, under each workspace
        .then(entries => rollupMarkdown(entries, { actions: false }))
        .catch(() => ''),
      goals: goalLines(identity),
    };

    let priorities: string[] = [];
    if (!(await this.overCap())) {
      try {
        const { planner } = await resolveModels(null, { sessionId: BRIEF_SESSION, notify: () => {} });
        const answer = await generatePlainText({
          chatModel: planner,
          messages: [
            // The active personality sets only the tone of the lines
            systemMessage(
              PRIORITIES_INSTRUCTIONS +
                briefContext(identity) +
                toneLine(await personalityStore.resolve(null).catch(() => null)),
            ),
            // Invite titles, chats and pages say what they like: data, never instructions
            userMessage(wrapUntrustedContent(stripTaskMarkers(briefMarkdown(data)))),
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
    // The brief vouches for the task lines it wrote: only those get a live checkbox
    await threadStore.addMessage(thread.id, 'planner', text, { taskIds: briefTaskIds(data) });
    await briefSettingsStore.updateSettings({ lastDay: localDate(now), lastThreadId: thread.id });

    if (notify) {
      // The counts and the top item by name; a meeting only by its time: invite titles are written by whoever
      // sent them. Whatever goes to WhatsApp is cut to one plain line with no links (whatsapp-remote/bridge.ts).
      const line = briefLine(data, { name: calendarName, state: calendar.state as SourceState }, t);
      emitNotice({ kind: 'brief', title: t('brief_ready'), body: line, key: `brief:${thread.id}` });
      await chrome.notifications
        .create(NOTIFICATION_ID, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icon-128.png'),
          title: t('brief_ready'),
          message: line,
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
    return isOverDailyBudget();
  }
}

/** When the calendar was last read: the time, with the day when that was not today. */
export function asOfText(asOf: number, now: number): string {
  const date = new Date(asOf);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${time}, ${date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`;
}

/**
 * Inbox items that need a decision: approvals not answered yet, and tasks reported stuck that the user has not
 * opened (src/background/retry). A snoozed item is not waiting now.
 */
export async function inboxDecisions(): Promise<InboxItem[]> {
  return (await db.inbox.toArray()).filter(
    item =>
      // An offer of help Ava made (../rounds) is hers to make, not a thing that waits on the user
      (item.kind === 'approval' &&
        (item.status === 'unread' || item.status === 'read') &&
        !item.approval?.requestId.startsWith('checkin:')) ||
      (item.kind === 'alert' && item.status === 'unread' && item.externalId.startsWith('stuck:')),
  );
}

/**
 * Agent and routine runs that wait for the user's click, by the name the user knows them by, with the chat or the
 * run each one waits on: an agent's run waits in its chat, a routine's browser step in a chat of its own, and a
 * routine's agent step on that agent's run. The brief counts each such chain once.
 */
export async function waitingRuns(): Promise<WaitingRun[]> {
  const runs = await db.runs.where('status').equals('waiting_user').toArray();
  return Promise.all(
    runs.map(async run => {
      const states = (await db.runSteps.where('runId').equals(run.id).toArray()).map(
        step => (step.state ?? {}) as { threadId?: unknown; agentRunId?: unknown },
      );
      const threadId = states.map(state => state.threadId).find((id): id is string => typeof id === 'string');
      const owner = run.agentId
        ? (await db.agents.get(run.agentId))?.name
        : run.workflowId
          ? (await db.workflows.get(run.workflowId))?.name
          : undefined;
      return {
        runId: run.id,
        name: owner || 'A run',
        threadId: threadId ?? null,
        innerRunIds: states.map(state => state.agentRunId).filter((id): id is string => typeof id === 'string'),
      };
    }),
  );
}
