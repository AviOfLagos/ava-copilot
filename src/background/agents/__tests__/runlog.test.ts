import { describe, expect, it } from 'vitest';
import type { RunRecord, RunStep, ThreadMessage, UsageEvent } from '@extension/storage';
import { buildRunLog, runThreadId } from '../runlog';

const t0 = Date.UTC(2026, 9, 12, 9);

const run: RunRecord = {
  id: 'run-1',
  kind: 'agent',
  workflowId: null,
  agentId: 'agent-1',
  workspaceId: null,
  trigger: { type: 'tab', detail: 'https://x.com/home' },
  status: 'succeeded',
  tainted: true,
  startedAt: t0,
  endedAt: t0 + 60_000,
  leaseUntil: null,
  inputTokens: 300,
  outputTokens: 30,
  costUsd: 0.002,
  error: null,
};

const step = (nodeId: string, fields: Partial<RunStep>): RunStep => ({
  id: nodeId,
  runId: run.id,
  nodeId,
  index: 0,
  status: 'succeeded',
  sideEffect: false,
  attempts: 1,
  startedAt: null,
  endedAt: null,
  input: null,
  output: null,
  error: null,
  ...fields,
});

const message = (seq: number, actor: ThreadMessage['actor'], content: string, at: number): ThreadMessage => ({
  id: `m${seq}`,
  threadId: 'thread-1',
  seq,
  actor,
  content,
  ts: at,
});

const usage = (at: number, cost: number | null): UsageEvent => ({
  id: `u${at}`,
  at,
  day: '2026-10-12',
  providerId: 'mock',
  model: 'scripted',
  role: 'thread',
  sessionId: 'thread-1',
  agentId: 'agent-1',
  workflowId: null,
  runId: null,
  workspaceId: null,
  inputTokens: 100,
  outputTokens: 10,
  costUsd: cost,
});

describe('buildRunLog', () => {
  const steps = [
    step('trigger', { startedAt: t0, endedAt: t0 }),
    step('task', {
      startedAt: t0 + 1000,
      state: { threadId: 'thread-1', tabId: 5, windowId: 9, startUrl: 'https://x.com/home', askedAt: t0 + 20_000 },
    }),
    step('publish', {
      endedAt: t0 + 59_000,
      output: { posted: [{ topic: 'social.mentions', recipients: 2, dropped: null }] },
    }),
  ];
  const messages = [
    message(1, 'user', 'You are "Watcher"…', t0 + 1500),
    message(2, 'navigator', 'Scroll to the newest posts', t0 + 5000),
    message(3, 'system', 'Rate limited, retrying in 2 s.', t0 + 8000),
    message(4, 'navigator', 'Waiting for you: Reply', t0 + 19_000),
    message(5, 'planner', '- Ada mentioned you', t0 + 58_000),
  ];
  const events = [usage(t0 + 4000, 0.001), usage(t0 + 30_000, null), usage(t0 + 57_000, 0.001)];

  it('puts trigger, task, chat, model calls, posts and the end on one timeline', () => {
    const { entries } = buildRunLog({ run, steps, messages, usage: events });
    expect(entries.map(entry => entry.kind)).toEqual([
      'trigger',
      'start',
      'task',
      'model',
      'action',
      'retry',
      'approval',
      'approval',
      'model',
      'model',
      'plan',
      'publish',
      'end',
    ]);
    expect(entries.find(entry => entry.kind === 'publish')).toMatchObject({ text: 'social.mentions', status: '2' });
    expect(entries.at(-1)).toMatchObject({ kind: 'end', status: 'succeeded' });
    const times = entries.map(entry => entry.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('sums what the run spent and how it went', () => {
    const { summary } = buildRunLog({ run, steps, messages, usage: events });
    expect(summary).toMatchObject({
      status: 'succeeded',
      durationMs: 60_000,
      modelCalls: 3,
      inputTokens: 300,
      outputTokens: 30,
      unpricedCalls: 1,
      actions: 1,
      retries: 1,
      errors: 0,
      models: ['scripted'],
    });
    expect(summary.costUsd).toBeCloseTo(0.002);
  });

  it('counts a failure and finds the run thread', () => {
    const failed = { ...run, status: 'failed' as const, error: { kind: 'budget', message: 'Too many steps' } };
    const log = buildRunLog({
      run: failed,
      steps,
      messages: [message(1, 'system', 'Task failed: boom', t0 + 2000)],
      usage: [],
    });
    expect(log.summary.errors).toBe(2);
    expect(log.entries.at(-1)).toMatchObject({ kind: 'end', text: 'Too many steps' });
    expect(runThreadId(steps)).toBe('thread-1');
    expect(runThreadId([])).toBeNull();
  });
});
