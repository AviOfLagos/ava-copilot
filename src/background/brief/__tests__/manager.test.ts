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
    reading = { state: 'failed', events: [], error: 'no permission', asOf: twoDaysAgo };
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
});
