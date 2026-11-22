import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  const area = {
    get: async (keys: string | string[]) =>
      Object.fromEntries(
        [keys]
          .flat()
          .filter(key => key in data)
          .map(key => [key, data[key]]),
      ),
    set: async (items: Record<string, unknown>) => void Object.assign(data, items),
    remove: async (key: string) => void delete data[key],
    onChanged: { addListener: () => undefined },
  };
  vi.stubGlobal('chrome', {
    storage: { local: area, session: area },
    notifications: { create: async () => '' },
    runtime: { getURL: (path: string) => path },
    // The key and what goes into it, so the tests read what was said without tying to a wording
    i18n: { getMessage: (key: string, subs?: string | string[]) => [key, ...[subs ?? []].flat()].join('|') },
  });
});

// No model in these tests: the brief comes without priorities, as it does over the daily budget
vi.mock('../../usage/budget', () => ({ isOverDailyBudget: async () => true }));
// The model factory pulls in the browser automation, which only loads inside the extension
vi.mock('../../threads/factory', () => ({ resolveModels: async () => ({}) }));
vi.mock('../../identity/context', () => ({ loadIdentityContext: async () => ({}) }));
vi.mock('../../identity/prompt', () => ({ briefContext: () => '', goalLines: () => [] }));
vi.mock('../../history/summaries', () => ({
  workspaceSummaries: { refresh: async () => [], rollup: async () => [] },
  rollupMarkdown: () => '',
}));

const { briefSettingsStore, db, threadStore } = await import('@extension/storage');
const { asOfText, MorningBrief } = await import('../manager');
const { registerNoticeSink } = await import('../../notices');
const { registerBriefExtra } = await import('../extras');
import type { CalendarReading, CalendarWatcher } from '../../calendar/watcher';
import type { Notice } from '../../notices';

/**
 * The whole morning brief, as it is made at 08:00 (docs/growth-team.md, Part 5a, issue #67): the chat it
 * writes and the line it sends to WhatsApp, from a calendar the test controls and the real stores.
 */

const HOUR = 3_600_000;
let reading: CalendarReading;
let notices: Notice[];
registerNoticeSink('test', notice => void notices.push(notice));

const make = async () => {
  const brief = new MorningBrief({ reading: async () => reading } as unknown as CalendarWatcher);
  const text = await brief.make();
  const { lastThreadId } = await briefSettingsStore.getSettings();
  const said = (await threadStore.messages(lastThreadId!)).map(message => message.content).join('\n');
  return { text, said, line: notices.at(-1)?.body ?? '' };
};

beforeEach(async () => {
  notices = [];
  reading = { state: 'read', events: [], error: null, asOf: Date.now() };
  await Promise.all([db.threads.clear(), db.messages.clear(), db.inbox.clear(), db.runs.clear(), db.agents.clear()]);
});

describe('the morning brief', () => {
  it('says the calendar is not connected, in the brief and on WhatsApp, instead of 0 meetings', async () => {
    reading = { state: 'not_connected', events: [], error: null, asOf: null };
    const { said, line } = await make();
    expect(said).toContain("**Today's calendar**\nbrief_calendar_notConnected");
    expect(said).not.toContain('Nothing on the calendar today');
    expect(line).toBe('brief_source_notConnected|brief_source_calendar brief_line_noWaiting');
    // The sources it read are listed, so the empty brief can be trusted
    expect(said).toMatch(/brief_sources_read\|brief_source_chats, brief_source_inbox, brief_source_agents/);
    expect(said).toContain('brief_source_notConnected|brief_source_calendar');
  });

  it('says so when the calendar could not be read, and still shows what it last knew', async () => {
    reading = {
      state: 'failed',
      events: [
        {
          id: 'a',
          title: 'Standup',
          start: Date.now() + HOUR,
          end: Date.now() + 2 * HOUR,
          joinUrl: null,
          allDay: false,
          location: '',
        },
      ],
      error: 'Ava Brain may not read the Calendar',
      asOf: Date.now() - 3 * HOUR,
    };
    const { said, line } = await make();
    expect(said).toMatch(/brief_calendar_failedAsOf\|[^\n]+\n- [^\n]*Standup/);
    expect(line.startsWith('brief_source_failed|brief_source_calendar')).toBe(true);
  });

  it('says which day the calendar was last read when that was not today', async () => {
    const twoDaysAgo = Date.now() - 48 * HOUR;
    const standup = {
      id: 'a',
      title: 'Standup',
      start: Date.now() + HOUR,
      end: Date.now() + 2 * HOUR,
      joinUrl: null,
      allDay: false,
      location: '',
    };
    reading = { state: 'failed', events: [standup], error: 'no permission', asOf: twoDaysAgo };
    const { said } = await make();
    const day = new Date(twoDaysAgo).toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    expect(said).toContain(day.replace(/[`<>[\]!]/g, ''));
    // The same day: the time alone
    expect(asOfText(new Date(2026, 10, 20, 9, 0).getTime(), new Date(2026, 10, 20, 10, 0).getTime())).not.toContain(
      ',',
    );
  });

  it('does not say "this is what it showed" over an empty list: with nothing to show it says meetings may be missing', async () => {
    reading = { state: 'failed', events: [], error: 'no permission', asOf: Date.now() - 60 * HOUR };
    const { said } = await make();
    expect(said).toContain("**Today's calendar**\nbrief_calendar_failed");
    expect(said).not.toContain('brief_calendar_failedAsOf');
  });

  it('counts a routine whose browser step waits for a click as 1, not as its chat plus its run', async () => {
    const thread = await threadStore.create({
      title: 'Post the weekly update',
      status: 'waiting_confirm',
      origin: 'workflow',
    });
    await db.runs.put({
      id: 'r1',
      kind: 'workflow',
      workflowId: 'w1',
      agentId: null,
      status: 'waiting_user',
      startedAt: 1,
    } as never);
    // A routine's step keeps its chat under its own node id, not under "task" as an agent's run does
    await db.runSteps.put({
      id: 's1',
      runId: 'r1',
      index: 0,
      nodeId: 'n-browse',
      status: 'waiting_user',
      state: { threadId: thread.id, tabId: 5 },
    } as never);
    const { said, line } = await make();
    expect(said).toContain('**Waiting on you (1)**');
    expect(line).toBe('brief_line_noMeetings brief_line_waiting|1|brief_item_approve|Post the weekly update');
    await db.runSteps.clear();
  });

  it('does not count an Inbox item whose chat was deleted, or an archived chat that still waits', async () => {
    await db.inbox.put({
      id: 'system|stuck:gone',
      source: 'system',
      externalId: 'stuck:gone',
      kind: 'alert',
      title: 'Stuck on a deleted chat',
      body: '',
      links: [],
      priority: 'high',
      status: 'unread',
      snoozeUntil: null,
      workspaceId: null,
      agentId: null,
      runId: null,
      approval: { requestId: 'thread:no-such-chat', action: 'open_thread' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await threadStore.create({ title: 'Archived and waiting', status: 'waiting_confirm', archived: true });
    const { said, line } = await make();
    expect(said).not.toContain('Waiting on you');
    expect(line).toBe('brief_line_noMeetings brief_line_noWaiting');
  });

  it('counts 1 waiting with one pending approval, and names it on WhatsApp', async () => {
    const thread = await threadStore.create({ title: 'Post the launch', status: 'waiting_confirm' });
    // The Inbox points at the same waiting chat: still one thing
    await db.inbox.put({
      id: 'system|needs:1',
      source: 'system',
      externalId: 'needs:1',
      kind: 'approval',
      title: 'Post the launch waits',
      body: '',
      links: [],
      priority: 'high',
      status: 'unread',
      snoozeUntil: null,
      workspaceId: null,
      agentId: null,
      runId: null,
      approval: { requestId: `thread:${thread.id}`, action: 'open_thread' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const { said, line } = await make();
    expect(said).toContain('**Waiting on you (1)**\n- "Post the launch" waits for your click');
    expect(line).toBe('brief_line_noMeetings brief_line_waiting|1|brief_item_approve|Post the launch');
  });

  it('counts a failed task, but not one that is queued to try again by itself', async () => {
    const failure = { kind: 'failed' as const, message: 'The page did not load' };
    await threadStore.create({
      title: 'Weekly numbers',
      status: 'error',
      error: failure,
      failure: { cls: 'temporary', retryAt: null, reported: true },
    });
    await threadStore.create({
      title: 'Daily check',
      status: 'error',
      error: failure,
      failure: { cls: 'temporary', retryAt: Date.now() + 60_000, reported: false },
    });
    const { said, line } = await make();
    expect(said).toContain('**Waiting on you (1)**\n- "Weekly numbers" stopped: The page did not load');
    expect(said).not.toContain('Daily check');
    expect(line).toBe('brief_line_noMeetings brief_line_waiting|1|brief_item_failed|Weekly numbers');
  });

  it('includes the sections other features add, and waits while one is still being made', async () => {
    let pending = true;
    registerBriefExtra({
      id: 'test-team',
      pending: async () => pending,
      sections: async () => [
        { title: 'Team · Suture', markdown: 'Standup did not run: it starts at 07:45.', workspaceId: null },
      ],
    });
    // Due, but a section is still being made: no brief yet
    await briefSettingsStore.updateSettings({ enabled: true, hour: 0, minute: 0, lastDay: '' });
    const brief = new MorningBrief({ reading: async () => reading } as unknown as CalendarWatcher);
    await brief.check();
    expect((await briefSettingsStore.getSettings()).lastDay).toBe('');
    pending = false;
    await brief.check();
    const { lastThreadId } = await briefSettingsStore.getSettings();
    // The brief's chat holds mail and invites written by others: no saved rule answers in it
    expect((await threadStore.get(lastThreadId!))?.tainted).toBe(true);
    const said = (await threadStore.messages(lastThreadId!)).map(message => message.content).join('\n');
    expect(said).toContain('**Team · Suture**\nStandup did not run: it starts at 07:45.');
    registerBriefExtra({ id: 'test-team', pending: async () => false, sections: async () => [] });
  });

  it('adds a section that ends while the brief is being made, once the brief is saved', async () => {
    // The brief reads its sources, then waits on a slow source while the standup ends
    let release: () => void = () => undefined;
    const slow = new Promise<void>(resolve => (release = resolve));
    registerBriefExtra({
      id: 'test-team',
      pending: async () => false,
      sections: async () => {
        await slow;
        return [];
      },
    });
    const brief = new MorningBrief({ reading: async () => reading } as unknown as CalendarWatcher);
    const making = brief.make({ notify: false });
    const added = brief.addSection({
      workflowId: 'growth-team',
      workflowName: 'Team · Suture',
      title: 'Team · Suture',
      markdown: 'Quiet day. Needed from you: nothing.',
      workspaceId: null,
      at: Date.now(),
    });
    release();
    await making;
    expect(await added).toBe(true);
    const { lastThreadId } = await briefSettingsStore.getSettings();
    const said = (await threadStore.messages(lastThreadId!)).map(message => message.content).join('\n');
    expect(said).toContain('Quiet day. Needed from you: nothing.');
    registerBriefExtra({ id: 'test-team', pending: async () => false, sections: async () => [] });
  });
});
