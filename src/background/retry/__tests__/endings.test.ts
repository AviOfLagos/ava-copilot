import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubGlobal('chrome', {
    i18n: { getMessage: (key: string, subs?: string | string[]) => [key, ...[subs ?? []].flat()].join('|') },
  });
});

const { RunEndings, retryJobKey, stuckItemId, THREAD_RETRY_JOB } = await import('../endings');
import type { RetryThreads, RunEndingDeps } from '../endings';
import type { AgentProfile, ConfirmRequest, InboxItem, ThreadRecord } from '@extension/storage';
import type { Notice } from '../../notices';

/**
 * Failed tasks retry, then report (docs/growth-team.md, Part 2, issue #66), on plain fakes: a job list, an
 * Inbox, a list of notices.
 */

let now: number;
let jobs: Map<string, { kind: string; key: string; runAt: number; payload: unknown }>;
let inbox: Map<string, InboxItem>;
let settled: string[];
let notices: Notice[];
let notes: string[];
let agents: Map<string, AgentProfile>;
let spent: Map<string, number>;
let endings: InstanceType<typeof RunEndings>;

const thread = (fields: Partial<ThreadRecord> = {}): ThreadRecord =>
  ({
    id: 'chat-1',
    title: 'Post the weekly update',
    status: 'error',
    taskRunId: 'task-1',
    autoTries: 0,
    origin: 'user',
    workspaceId: 'w1',
    agentId: null,
    activeTask: 'Post the weekly update',
    ...fields,
  }) as ThreadRecord;

const networkDown = { kind: 'failed' as const, message: 'The page did not load' };

beforeEach(() => {
  now = new Date(2026, 10, 20, 10, 0, 0).getTime();
  jobs = new Map();
  inbox = new Map();
  settled = [];
  notices = [];
  notes = [];
  agents = new Map();
  spent = new Map();
  const deps: RunEndingDeps = {
    schedule: async request => void jobs.set(request.key, request),
    cancelJob: async key => void jobs.delete(key),
    // Like the real Inbox: the same source and id never lands twice
    inbox: async draft => {
      const id = `${draft.source}|${draft.externalId}`;
      if (!inbox.has(id)) inbox.set(id, { ...draft, id, status: 'unread' } as unknown as InboxItem);
    },
    inboxItem: async id => inbox.get(id),
    settleInbox: async id => void settled.push(id),
    notice: notice => void notices.push(notice),
    note: async (_threadId, text) => void notes.push(text),
    agent: async id => agents.get(id),
    agentSpentUsd: async id => spent.get(id) ?? 0,
    now: () => now,
  };
  endings = new RunEndings(deps);
});

describe('a run that ends with an error', () => {
  it('is queued again after 1, 5, then 15 minutes, as the same task, and says so in the chat', async () => {
    const delays: number[] = [];
    let record = thread();
    for (let round = 0; round < 3; round++) {
      const ending = await endings.ended(record, networkDown, 'max_failures');
      expect(ending.failure).toMatchObject({ cls: 'temporary', reported: false });
      delays.push((ending.failure.retryAt! - now) / 60_000);
      expect(jobs.get(retryJobKey('chat-1', round))).toMatchObject({
        kind: THREAD_RETRY_JOB,
        runAt: ending.failure.retryAt,
        payload: { threadId: 'chat-1', taskRunId: 'task-1' },
      });
      record = thread({ autoTries: ending.autoTries });
    }
    expect(delays).toEqual([1, 5, 15]);
    expect(notes).toEqual(['retry_queued|1|1|3', 'retry_queued|5|2|3', 'retry_queued|15|3|3']);
    // Nothing is said outside the chat while tries are left
    expect(inbox.size).toBe(0);
    expect(notices).toEqual([]);
  });

  it('after the last failed try, leaves exactly one Inbox item and one WhatsApp line, however often it is asked', async () => {
    const stuck = thread({ autoTries: 3 });
    const ending = await endings.ended(stuck, networkDown, 'max_failures');
    expect(ending).toEqual({ failure: { cls: 'temporary', retryAt: null, reported: true }, autoTries: 3 });
    expect(jobs.size).toBe(0);
    await endings.ended(stuck, networkDown, 'max_failures');
    await endings.report(stuck, 'temporary', 'again');

    expect([...inbox.values()]).toHaveLength(1);
    const item = inbox.get(stuckItemId(stuck))!;
    expect(item).toMatchObject({
      kind: 'alert',
      priority: 'high',
      title: 'retry_stuck_title|Post the weekly update',
      body: 'The page did not load. retry_need_temporary|3',
      approval: { requestId: 'thread:chat-1', action: 'open_thread' },
    });
    expect(notices).toEqual([
      {
        kind: 'approval',
        title: 'retry_stuck_line|Post the weekly update|The page did not load.|retry_need_temporary|3',
        key: stuckItemId(stuck),
      },
    ]);
  });

  it('is not retried when it needs the user: one Inbox item names the step, and WhatsApp stays quiet', async () => {
    const ending = await endings.ended(thread(), { kind: 'failed', message: 'The API key was refused' }, 'auth');
    expect(ending.failure).toEqual({ cls: 'needs_user', retryAt: null, reported: true });
    expect(jobs.size).toBe(0);
    expect([...inbox.values()].map(item => item.body)).toEqual(['The API key was refused. retry_need_key']);
    expect(notices).toEqual([]);
  });

  it('is not retried when it cannot be done: one Inbox item says why', async () => {
    const ending = await endings.ended(
      thread(),
      { kind: 'failed', message: 'That site is blocked' },
      'url_not_allowed',
    );
    expect(ending.failure.cls).toBe('cannot');
    expect([...inbox.values()].map(item => item.body)).toEqual(['That site is blocked. retry_need_cannot']);
    expect(jobs.size).toBe(0);
  });

  it('names an agent’s run by the agent, and sends no second WhatsApp line for a chat started on WhatsApp', async () => {
    agents.set('a1', { id: 'a1', name: 'Growth Lead', budget: { dailyUsd: 1 } } as AgentProfile);
    await endings.ended(thread({ agentId: 'a1', autoTries: 3 }), networkDown, null);
    expect([...inbox.values()][0]).toMatchObject({ title: 'retry_stuck_title|Growth Lead', agentId: 'a1' });
    expect(notices).toHaveLength(1);

    await endings.ended(
      thread({ id: 'chat-2', taskRunId: 'task-2', origin: 'whatsapp', autoTries: 3 }),
      networkDown,
      null,
    );
    expect(inbox.size).toBe(2);
    // The WhatsApp bridge answers that chat itself
    expect(notices).toHaveLength(1);
  });
});

describe('the queued try', () => {
  it('is one job per try, dropped whichever it is, and put back when the background starts', async () => {
    const first = await endings.ended(thread(), networkDown, null);
    const second = await endings.ended(thread({ autoTries: first.autoTries }), networkDown, null);
    expect([...jobs.keys()]).toEqual([retryJobKey('chat-1', 0), retryJobKey('chat-1', 1)]);
    await endings.cancel('chat-1');
    expect(jobs.size).toBe(0);

    // The job list lost it, the chat still says when it will try: the try is queued again at that time
    await endings.requeue(thread({ autoTries: second.autoTries, failure: second.failure }));
    expect(jobs.get(retryJobKey('chat-1', 1))).toMatchObject({ runAt: second.failure.retryAt });
    await endings.requeue(thread({ failure: { cls: 'temporary', retryAt: null, reported: true } }));
    expect(jobs.size).toBe(1);
  });
});

describe('a step only the user can do', () => {
  const signIn = (fields: Partial<ConfirmRequest> = {}): ConfirmRequest =>
    ({
      id: crypto.randomUUID(),
      taskId: 'chat-1',
      mode: 'needs_user',
      kind: 'login',
      intent: 'Sign in',
      target: 'Password',
      pageTitle: 'Sign in',
      pageUrl: 'https://admin.trysuture.com/login',
      fields: [],
      context: '',
      ...fields,
    }) as ConfirmRequest;

  it('is exactly one Inbox item that says so, however often the task asks, and is settled after', async () => {
    await endings.asked(thread({ status: 'waiting_confirm' }), signIn());
    await endings.asked(thread({ status: 'waiting_confirm' }), signIn());
    expect([...inbox.values()]).toHaveLength(1);
    expect([...inbox.values()][0]).toMatchObject({
      kind: 'approval',
      priority: 'high',
      title: 'retry_needs_login|Post the weekly update',
      body: 'retry_needs_body|admin.trysuture.com',
      approval: { requestId: 'thread:chat-1', action: 'open_thread' },
    });
    await endings.settled(thread());
    expect(settled).toContain('system|needs:task-1:login');
  });

  it('is left to the agent’s own Inbox item for an agent’s run, and is not made for a plain approval', async () => {
    await endings.asked(thread({ agentId: 'a1' }), signIn());
    await endings.asked(thread(), signIn({ mode: 'commit', kind: 'send' }));
    await endings.asked(thread(), signIn({ kind: 'questions' }));
    expect(inbox.size).toBe(0);
  });
});

describe('the retry job', () => {
  const port = (record: ThreadRecord | undefined, resume = vi.fn(async () => {})) => {
    const threads: RetryThreads = {
      thread: async () => record,
      resume,
      postpone: vi.fn(async () => {}),
      giveUp: vi.fn(async () => {}),
    };
    return threads;
  };
  const queued = (fields: Partial<ThreadRecord> = {}) =>
    thread({ failure: { cls: 'temporary', retryAt: now, reported: false }, autoTries: 1, ...fields });
  const job = (attempts = 1) => ({ payload: { threadId: 'chat-1', taskRunId: 'task-1' }, attempts });

  it('picks the task up again', async () => {
    const threads = port(queued());
    await endings.runRetry(job(), threads);
    expect(threads.resume).toHaveBeenCalledWith('chat-1');
  });

  it('does nothing when the user moved on: a new request, Stop, a manual retry, a deleted chat', async () => {
    for (const record of [
      undefined,
      queued({ taskRunId: 'a-new-request' }),
      queued({ status: 'running' }),
      queued({ status: 'idle' }),
      queued({ failure: { cls: 'temporary', retryAt: null, reported: false } }),
    ]) {
      const threads = port(record);
      await endings.runRetry(job(), threads);
      expect(threads.resume).not.toHaveBeenCalled();
    }
  });

  it('waits for tomorrow instead of retrying when the agent spent its money for the day', async () => {
    agents.set('a1', { id: 'a1', name: 'Growth Lead', budget: { dailyUsd: 1 } } as AgentProfile);
    spent.set('a1', 1.2);
    const threads = port(queued({ agentId: 'a1' }));
    const thrown = await endings.runRetry(job(), threads).catch(error => error);
    expect(thrown).toMatchObject({ kind: 'budget', retryable: true });
    // Just after midnight, local time
    const at = new Date(now + thrown.retryAfterMs);
    expect([at.getDate(), at.getHours(), at.getMinutes()]).toEqual([21, 0, 1]);
    expect(threads.postpone).toHaveBeenCalledWith('chat-1', now + thrown.retryAfterMs);
    expect(threads.resume).not.toHaveBeenCalled();

    // Under its cap it goes ahead: the spend of earlier tries counts, the try itself is not a new run
    spent.set('a1', 0.4);
    await endings.runRetry(job(), threads);
    expect(threads.resume).toHaveBeenCalledTimes(1);
  });

  it('tries again shortly when the task cannot start now, and gives up with a report rather than queue for ever', async () => {
    const busy = vi.fn(async () => {
      throw new Error('Too many tasks are running');
    });
    const threads = port(queued(), busy);
    await expect(endings.runRetry(job(1), threads)).rejects.toMatchObject({
      kind: 'unavailable',
      retryable: true,
      retryAfterMs: 30_000,
    });
    expect(threads.giveUp).not.toHaveBeenCalled();
    await endings.runRetry(job(5), threads);
    expect(threads.giveUp).toHaveBeenCalledWith('chat-1');
  });
});
