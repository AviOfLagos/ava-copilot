import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[]) =>
          Object.fromEntries(keys.filter(k => k in data).map(k => [k, structuredClone(data[k])])),
        set: async (items: Record<string, unknown>) => Object.assign(data, structuredClone(items)),
        onChanged: { addListener: () => undefined },
      },
    },
  });
  return data;
});

vi.mock('@extension/i18n', () => ({
  t: (key: string, substitutions?: string | string[]) => `${key}:${[substitutions].flat().join(',')}`,
}));

const { AviCopilotDb, localDay, modelSettingsStore, usageStore } = await import('@extension/storage');
const { recordPricedUsage, recordUsage, priceOfCall } = await import('../meter');
const { pruneUsageEvents } = await import('../retention');
const { budgetState, ensureBudget, isOverDailyBudget } = await import('../budget');
import type { ModelCatalogEntry } from '@extension/storage';

let db: InstanceType<typeof AviCopilotDb>;
const today = localDay();

const catalogEntry = (providerId: string, model: string, extra: Partial<ModelCatalogEntry>): ModelCatalogEntry => ({
  id: `${providerId}:${model}`,
  providerId,
  model,
  label: model,
  local: false,
  contextTokens: null,
  inputUsdPerM: null,
  outputUsdPerM: null,
  modalities: ['chat', 'text'],
  tools: null,
  health: 'ok',
  seenAt: 1,
  ...extra,
});

beforeEach(async () => {
  for (const key of Object.keys(store)) delete store[key];
  store['llm-api-keys'] = {
    providers: {
      gemini: { apiKey: '', type: 'gemini' },
      openrouter: { apiKey: '', type: 'openrouter' },
      ollama: { apiKey: 'ollama', type: 'ollama', baseUrl: 'http://localhost:11434/v1' },
      lan: { apiKey: '', type: 'custom_openai', baseUrl: 'http://127.0.0.1:8080/v1' },
      mock: { apiKey: '', type: 'custom_openai', baseUrl: 'https://llm.example.test/v1' },
    },
  };
  // The store keeps its own copy in memory: clear it through the store, not only underneath it
  await usageStore.clear();
  db = new AviCopilotDb(`usage-${crypto.randomUUID()}`);
  await db.modelCatalog.bulkPut([
    catalogEntry('openrouter', 'anthropic/claude-opus-5-5', { inputUsdPerM: 15, outputUsdPerM: 75 }),
    catalogEntry('lan', 'served', { local: true, inputUsdPerM: 0, outputUsdPerM: 0 }),
  ]);
});

describe('pricing a call', () => {
  it('uses Gemini’s table, the registry’s price, and nothing for local servers; unknown stays unknown', async () => {
    const call = { inputTokens: 1_000_000, outputTokens: 100_000, day: '2026-10-12' };
    expect(await priceOfCall({ ...call, providerId: 'gemini', model: 'gemini-3.8-flash' }, db)).toBeCloseTo(1.125);
    expect(
      await priceOfCall({ ...call, providerId: 'openrouter', model: 'anthropic/claude-opus-5-5' }, db),
    ).toBeCloseTo(22.5);
    expect(await priceOfCall({ ...call, providerId: 'ollama', model: 'anything' }, db)).toBe(0);
    expect(await priceOfCall({ ...call, providerId: 'lan', model: 'served' }, db)).toBe(0);
    expect(await priceOfCall({ ...call, providerId: 'mock', model: 'scripted' }, db)).toBeNull();
    // A caller that names only the model (the embedder) still gets Gemini's price
    expect(await priceOfCall({ ...call, model: 'gemini-embedding-2' }, db)).toBeCloseTo(0.2);
  });
});

describe('recordUsage', () => {
  it('records an event per call and keeps the daily totals, with unknown prices as tokens', async () => {
    await recordUsage('s1', 'anthropic/claude-opus-5-5', 1000, 100, { providerId: 'openrouter', role: 'smart' }, db);
    const unpriced = await recordUsage('s1', 'scripted', 400, 100, { providerId: 'mock' }, db);

    expect(unpriced).toMatchObject({ costUsd: null, role: 'thread', providerId: 'mock', day: today });
    const events = await db.usageEvents.toArray();
    expect(events).toHaveLength(2);
    expect(events.find(event => event.model === 'anthropic/claude-opus-5-5')).toMatchObject({
      role: 'smart',
      costUsd: expect.closeTo(0.0225, 6),
    });

    const day = await usageStore.getDay(today);
    expect(day).toMatchObject({ calls: 2, unpricedCalls: 1, unpricedTokens: 500, inputTokens: 1400 });
    expect(day.costUsd).toBeCloseTo(0.0225);
    expect((await usageStore.getSession('s1')).calls).toBe(2);
  });

  it('takes a chat’s workspace and agent from its thread, unless the caller says', async () => {
    await db.threads.put({ id: 'thread-1', workspaceId: 'nexprove', agentId: 'scout' } as never);
    const fromThread = await recordUsage('thread-1', 'gemini-3.8-flash', 10, 1, { providerId: 'gemini' }, db);
    expect(fromThread).toMatchObject({ workspaceId: 'nexprove', agentId: 'scout', workflowId: null });

    const explicit = await recordUsage(
      'thread-1',
      'gemini-3.8-flash',
      10,
      1,
      {
        providerId: 'gemini',
        workspaceId: 'ellum-ai',
        agentId: null,
        workflowId: 'news',
        runId: 'run-1',
        role: 'fast',
      },
      db,
    );
    expect(explicit).toMatchObject({ workspaceId: 'ellum-ai', agentId: null, workflowId: 'news', runId: 'run-1' });
  });

  it('records audio priced by the minute as an event with its cost and no tokens', async () => {
    const event = await recordPricedUsage(
      'voice',
      'gemini-live-3-flash',
      0.04,
      { providerId: 'gemini', role: 'realtime' },
      db,
    );
    expect(event).toMatchObject({ costUsd: 0.04, inputTokens: 0, outputTokens: 0, role: 'realtime' });
    expect((await usageStore.getDay(today)).costUsd).toBeCloseTo(0.04);
  });

  it('keeps 90 days of events', async () => {
    const old = { ...(await recordUsage('s', 'm', 1, 1, {}, db)), id: 'old', day: '2026-01-01' };
    await db.usageEvents.put(old);
    expect(await pruneUsageEvents(db, new Date(2026, 9, 12))).toBe(1);
    expect(await db.usageEvents.count()).toBe(1);
  });
});

describe('the daily caps', () => {
  const context = (taskId: string, answer: 'approved' | 'declined') => {
    const asked: unknown[] = [];
    let stopped = false;
    return {
      asked,
      stopped: () => stopped,
      value: {
        taskId,
        controller: new AbortController(),
        emitEvent: async () => {},
        stop: async () => {
          stopped = true;
        },
        confirmGate: {
          ask: async (request: unknown) => {
            asked.push(request);
            return answer;
          },
        },
      },
    };
  };

  it('holds a chat on a model with no price once the token cap is reached, and not a chat on priced models', async () => {
    await modelSettingsStore.updateSettings({ unpricedDailyTokenCap: 1000 });
    await recordUsage('free-chat', 'scripted', 900, 200, { providerId: 'mock' }, db);
    await recordUsage('paid-chat', 'gemini-3.8-flash', 10, 1, { providerId: 'gemini' }, db);

    expect(await budgetState()).toMatchObject({
      overTokens: true,
      overCost: false,
      unpricedTokens: 1100,
      tokenCap: 1000,
    });
    expect(await isOverDailyBudget()).toBe(true);

    const paid = context('paid-chat', 'approved');
    expect(await ensureBudget(paid.value as never)).toBe(true);
    expect(paid.asked).toHaveLength(0);

    const free = context('free-chat', 'declined');
    expect(await ensureBudget(free.value as never)).toBe(false);
    expect(free.asked[0]).toMatchObject({ kind: 'cap', target: expect.stringContaining('models_tokenCap_reached') });
    expect(free.stopped()).toBe(true);

    // 0 means no cap
    await modelSettingsStore.updateSettings({ unpricedDailyTokenCap: 0 });
    expect(await ensureBudget(context('free-chat', 'declined').value as never)).toBe(true);
  });
});
