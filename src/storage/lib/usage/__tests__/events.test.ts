import { describe, expect, it } from 'vitest';
import { lastDays, retentionCutoffDay, summarizeUsage, totalUsage } from '../events';
import type { UsageEvent } from '../../models/types';

let next = 0;
const event = (extra: Partial<UsageEvent>): UsageEvent => ({
  id: `e${next++}`,
  at: 0,
  day: '2026-10-12',
  providerId: 'gemini',
  model: 'gemini-3.8-flash',
  role: 'thread',
  sessionId: 's1',
  agentId: null,
  workflowId: null,
  runId: null,
  workspaceId: null,
  inputTokens: 100,
  outputTokens: 10,
  costUsd: 0.01,
  ...extra,
});

const events: UsageEvent[] = [
  event({ day: '2026-10-10', costUsd: 0.5, agentId: 'scout', workspaceId: 'nexprove' }),
  event({ day: '2026-10-12', costUsd: 0.25, workflowId: 'news', workspaceId: 'nexprove' }),
  event({
    day: '2026-10-12',
    providerId: 'custom',
    model: 'free-model',
    costUsd: null,
    inputTokens: 1000,
    outputTokens: 500,
  }),
  event({ day: '2026-10-12', providerId: 'ollama', model: 'qwen3.8', costUsd: 0, agentId: 'scout' }),
  // Outside the window asked for
  event({ day: '2026-09-01', costUsd: 9 }),
];

describe('summarizeUsage', () => {
  it('adds up by day, with a row for every day of the window, oldest first', () => {
    const days = ['2026-10-10', '2026-10-11', '2026-10-12'];
    const rows = summarizeUsage(events, 'day', days);
    expect(rows.map(row => row.key)).toEqual(days);
    expect(rows[0]).toMatchObject({ costUsd: 0.5, calls: 1 });
    expect(rows[1]).toMatchObject({ costUsd: 0, calls: 0 });
    expect(rows[2]).toMatchObject({ calls: 3, unpricedCalls: 1, unpricedTokens: 1500 });
    expect(rows[2].costUsd).toBeCloseTo(0.25);
  });

  it('adds up by model, agent, routine and workspace, most expensive first; unknown prices count tokens only', () => {
    const recent = events.slice(0, 4);
    expect(summarizeUsage(recent, 'model').map(row => row.key)).toEqual([
      'gemini:gemini-3.8-flash',
      // No cost, more tokens
      'custom:free-model',
      'ollama:qwen3.8',
    ]);
    expect(summarizeUsage(recent, 'agent')).toEqual([
      expect.objectContaining({ key: 'scout', costUsd: 0.5, calls: 2 }),
      expect.objectContaining({ key: '', calls: 2, unpricedTokens: 1500 }),
    ]);
    expect(summarizeUsage(recent, 'workflow').find(row => row.key === 'news')).toMatchObject({
      costUsd: 0.25,
      calls: 1,
    });
    expect(summarizeUsage(recent, 'workspace')[0]).toMatchObject({ key: 'nexprove', costUsd: 0.75, calls: 2 });
    expect(summarizeUsage(recent, 'provider').map(row => row.key)).toEqual(['gemini', 'custom', 'ollama']);
  });

  it('totals everything', () => {
    const total = totalUsage(events.slice(0, 4));
    expect(total.calls).toBe(4);
    expect(total.costUsd).toBeCloseTo(0.75);
    expect(total.unpricedCalls).toBe(1);
    expect(total.inputTokens).toBe(1300);
  });
});

describe('days', () => {
  it('lists the last days up to today, and the first day the retention job keeps', () => {
    const now = new Date(2026, 9, 12, 9, 30);
    expect(lastDays(3, now)).toEqual(['2026-10-10', '2026-10-11', '2026-10-12']);
    // Across a month and a daylight-saving change
    expect(lastDays(2, new Date(2026, 10, 1, 0, 30))).toEqual(['2026-10-31', '2026-11-01']);
    expect(retentionCutoffDay(now)).toBe('2026-07-14');
    expect(retentionCutoffDay(now, 1)).toBe('2026-10-11');
  });
});
