import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InboxItem, ThreadRecord, UpcomingEvent } from '@extension/storage';
import { briefLine, briefMarkdown, sourcesLine, stoppedThreads, waitingItems } from '../brief';
import type { BriefData, SourceState } from '../brief';

/**
 * The morning brief tells the truth (docs/growth-team.md, Part 5a, issue #67): a source that is not connected
 * is named, never shown as 0; "waiting on you" counts everything that waits, each thing once; the WhatsApp line
 * names the top item. The lines are checked in the words the user reads (the English locale file).
 */

const messages = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../public/_locales/en/messages.json'), 'utf8'),
) as Record<string, { message: string }>;
const say = (key: string, subs: string[] = []) =>
  messages[key].message.replace(/\$(\d)/g, (_, index: string) => subs[Number(index) - 1] ?? '');

const NOW = new Date(2026, 10, 20, 8, 0).getTime();
const HOUR = 3_600_000;
const at = (hour: number, minute = 0) => new Date(2026, 10, 20, hour, minute).getTime();
const clock = (time: number) => new Date(time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const meeting = (id: string, start: number): UpcomingEvent => ({
  id,
  title: `Meeting ${id}`,
  start,
  end: start + HOUR,
  joinUrl: null,
});
const chat = (id: string, fields: Partial<ThreadRecord> = {}): ThreadRecord =>
  ({
    id,
    title: `Chat ${id}`,
    status: 'waiting_confirm',
    updatedAt: NOW - HOUR,
    archived: false,
    ...fields,
  }) as ThreadRecord;
const inboxItem = (id: string, fields: Partial<InboxItem> = {}): InboxItem =>
  ({
    id,
    source: 'system',
    externalId: id,
    kind: 'approval',
    title: `Inbox ${id}`,
    status: 'unread',
    runId: null,
    approval: null,
    ...fields,
  }) as InboxItem;
const brief = (fields: Partial<BriefData> = {}): BriefData => ({
  now: NOW,
  events: [],
  tasks: [],
  decisions: [],
  waiting: [],
  stopped: [],
  workspaces: [],
  ...fields,
});
const calendar = (state: SourceState = 'read') => ({ name: say('brief_source_calendar'), state });

describe('a source that is not connected', () => {
  it('is named as not connected, in the brief and in the WhatsApp line, never shown as 0 or as a free day', () => {
    const data = brief({ calendarNote: say('brief_calendar_notConnected') });
    const text = briefMarkdown(data);
    expect(text).toContain('Calendar: not connected.');
    expect(text).not.toContain('Nothing on the calendar today');

    const line = briefLine(data, calendar('not_connected'), say);
    expect(line).toBe('Calendar: not connected. Nothing waiting on you.');
    expect(line).not.toMatch(/\b0\b/);
  });

  it('says a calendar that could not be read could not be read, and shows what it last knew as such', () => {
    const data = brief({
      events: [meeting('a', at(10))],
      calendarNote: say('brief_calendar_failedAsOf', ['7:10 AM']),
    });
    const text = briefMarkdown(data);
    expect(text).toMatch(/Calendar: could not be read this morning\. This is what it showed at 7:10 AM/);
    expect(text).toContain('Meeting a');
    expect(briefLine(data, calendar('failed'), say)).toBe('Calendar: could not be read. Nothing waiting on you.');
  });

  it('still says a connected calendar with nothing on it is a free day', () => {
    expect(briefMarkdown(brief())).toContain('Nothing on the calendar today.');
    expect(briefLine(brief(), calendar(), say)).toBe('No meetings today. Nothing waiting on you.');
  });
});

describe('what waits on you', () => {
  it('is 1 with one pending approval, however many places show it', () => {
    const waiting = [chat('t1', { title: 'Post the launch' })];
    // The same approval is also an Inbox item pointing at the chat
    const inbox = [inboxItem('agent:a1|r1:click', { approval: { requestId: 'thread:t1', action: 'open_thread' } })];
    const data = brief({ waiting, inbox });
    expect(waitingItems(data)).toHaveLength(1);
    expect(briefMarkdown(data)).toContain('**Waiting on you (1)**\n- "Post the launch" waits for your click');
    expect(briefLine(data, calendar(), say)).toBe('No meetings today. 1 waiting on you: approve Post the launch.');
  });

  it('counts Inbox decisions, agent runs waiting for a click, failed tasks and paused chats, each once', () => {
    const data = brief({
      waiting: [
        chat('t1', { title: 'Reply to the beta tester', agentId: 'social' }),
        chat('t2', { title: 'Admin check', pendingRequest: { mode: 'needs_user', kind: 'login' } as never }),
      ],
      stopped: [
        chat('t3', { title: 'Weekly numbers', status: 'error', error: { kind: 'failed', message: 'It timed out' } }),
      ],
      runs: [
        // The social agent's run waits in chat t1: the same wait
        { runId: 'r1', name: 'Product Social Manager', threadId: 't1' },
        // A routine waiting on a step, with its own Inbox item
        { runId: 'r2', name: 'Monday report', threadId: null },
      ],
      inbox: [
        inboxItem('agent:social|r1:click', {
          runId: 'r1',
          approval: { requestId: 'thread:t1', action: 'open_thread' },
        }),
        inboxItem('workflow:w1|r2:step', { runId: 'r2', title: 'Approve the Monday report' }),
        inboxItem('system|stuck:task-3', {
          kind: 'alert',
          title: 'Stuck on Weekly numbers',
          approval: { requestId: 'thread:t3', action: 'open_thread' },
        }),
        inboxItem('slack|approve-7', { title: 'Approve the Suture post' }),
      ],
      agentNames: { social: 'Product Social Manager' },
    });
    expect(waitingItems(data).map(item => `${item.kind}: ${item.title}`)).toEqual([
      'approval: Product Social Manager',
      'needs_user: Admin check',
      'approval: Monday report',
      'decision: Approve the Suture post',
      'failed: Weekly numbers',
    ]);
    const text = briefMarkdown(data);
    expect(text).toContain('**Waiting on you (5)**');
    expect(text).toContain('- "Weekly numbers" stopped: It timed out');
    expect(text).toContain('- Approve the Suture post (in your Inbox)');
  });

  it('counts a routine waiting on a click once, whether it waits in a chat of its own or on an agent’s run', () => {
    // A routine's browser step asks before acting: its chat waits, its run waits, and the Inbox has its item
    const browserStep = brief({
      waiting: [chat('t1', { title: 'Post the weekly update' })],
      runs: [{ runId: 'r1', name: 'Monday report', threadId: 't1' }],
      inbox: [
        inboxItem('workflow:w1|r1:n1', { runId: 'r1', approval: { requestId: 'thread:t1', action: 'open_thread' } }),
      ],
    });
    expect(waitingItems(browserStep)).toHaveLength(1);
    expect(briefLine(browserStep, calendar(), say)).toBe(
      'No meetings today. 1 waiting on you: approve Post the weekly update.',
    );

    // A routine whose step is an agent's run: the routine's run waits on the agent's run, which waits in its chat
    const agentStep = brief({
      waiting: [chat('t2', { title: 'Draft the post', agentId: 'social' })],
      runs: [
        { runId: 'outer', name: 'Launch routine', threadId: null, innerRunIds: ['inner'] },
        { runId: 'inner', name: 'Product Social Manager', threadId: 't2' },
      ],
      inbox: [
        inboxItem('agent:social|inner:click', {
          runId: 'inner',
          approval: { requestId: 'thread:t2', action: 'open_thread' },
        }),
      ],
      agentNames: { social: 'Product Social Manager' },
    });
    expect(waitingItems(agentStep).map(item => item.title)).toEqual(['Product Social Manager']);
  });

  it('says a chat held at the spending limit is at its limit, not that it needs a sign-in', () => {
    const data = brief({
      waiting: [chat('t1', { title: 'Research run', pendingRequest: { mode: 'needs_user', kind: 'cap' } as never })],
    });
    expect(briefLine(data, calendar(), say)).toBe(
      'No meetings today. 1 waiting on you: Research run is at its spending limit.',
    );
    expect(briefMarkdown(data)).toContain('- "Research run" is held at the spending limit');
  });

  it('does not count a failed task that is queued to try again by itself, an archived one, or an old one', () => {
    const failed = (id: string, fields: Partial<ThreadRecord> = {}) =>
      chat(id, { status: 'error', error: { kind: 'tab_closed', message: 'The tab was closed.' }, ...fields });
    const counted = stoppedThreads(
      [
        failed('stuck', { failure: { cls: 'temporary', retryAt: null, reported: true } }),
        failed('queued', { failure: { cls: 'temporary', retryAt: NOW + 60_000, reported: false } }),
        failed('archived', { archived: true }),
        failed('old', { updatedAt: NOW - 30 * HOUR }),
        chat('fine', { status: 'idle' }),
      ],
      NOW,
    );
    expect(counted.map(thread => thread.id)).toEqual(['stuck']);
  });
});

describe('the WhatsApp line', () => {
  it('names the first meeting by its time and the top item by name', () => {
    const data = brief({
      events: [meeting('b', at(14)), meeting('a', at(10))],
      waiting: [chat('t1', { title: 'Suture post' })],
      inbox: [inboxItem('i1', { title: 'Beta reply from Ada' }), inboxItem('i2', { title: 'Beta reply from Tomi' })],
    });
    expect(briefLine(data, calendar(), say)).toBe(
      `2 meetings, first at ${clock(at(10))}. 3 waiting on you: approve Suture post, and 2 more.`,
    );
  });

  it('does not call an all-day entry a meeting, or give it a time', () => {
    const holiday = { ...meeting('h', new Date(2026, 10, 20, 0, 0).getTime()), title: 'Public holiday', allDay: true };
    const data = brief({ events: [{ ...holiday, end: holiday.start + 24 * HOUR }] });
    expect(briefLine(data, calendar(), say)).toBe('No meetings today. Nothing waiting on you.');
    expect(briefMarkdown(data)).toContain('- All day: Public holiday');
    const withMeeting = brief({ events: [{ ...holiday, end: holiday.start + 24 * HOUR }, meeting('a', at(10))] });
    expect(briefLine(withMeeting, calendar(), say)).toBe(`1 meeting, at ${clock(at(10))}. Nothing waiting on you.`);
  });

  it('never carries a meeting’s title, and keeps what a page or an invite wrote on one plain line', () => {
    const data = brief({
      events: [{ ...meeting('a', at(10)), title: 'Click https://evil.test now' }],
      waiting: [chat('t1', { title: 'Post\n![x](https://evil.test) `now`' })],
    });
    const line = briefLine(data, calendar(), say);
    expect(line).toBe(`1 meeting, at ${clock(at(10))}. 1 waiting on you: approve Post x(https://evil.test) now.`);
    expect(line).not.toContain('Click');
    expect(line).not.toMatch(/[`\n[\]!]/);
  });
});

describe('a brief with nothing in it', () => {
  it('says which sources it read and which it could not, so "nothing" can be trusted', () => {
    const line = sourcesLine(
      [
        { name: 'Calendar', state: 'not_connected' },
        { name: 'chats', state: 'read' },
        { name: 'Inbox', state: 'read' },
        { name: 'agents', state: 'failed' },
      ],
      say,
    );
    expect(line).toBe('Read: chats, Inbox. Calendar: not connected. agents: could not be read.');
    const text = briefMarkdown(brief({ sourcesLine: line, calendarNote: say('brief_calendar_notConnected') }));
    expect(text).not.toContain('Waiting on you');
    expect(text.trim().endsWith('_Read: chats, Inbox. Calendar: not connected. agents: could not be read._')).toBe(
      true,
    );
  });
});
