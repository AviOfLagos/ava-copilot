import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[] | string) =>
          Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, structuredClone(data[k])]),
          ),
        set: async (items: Record<string, unknown>) => Object.assign(data, structuredClone(items)),
        onChanged: { addListener: () => undefined },
      },
      session: { get: async () => ({}), set: async () => undefined },
    },
  });
  return data;
});

vi.mock('@extension/i18n', () => ({ t: (key: string) => key }));

const { db, modelSettingsStore } = await import('@extension/storage');
const { forgetLocalChecks, lightModel, lightRoute } = await import('../light');
const { recordUsage } = await import('../../usage/meter');
const { resetBreakers } = await import('../breakers');
import { fakeFetch, networkDown } from './fakeFetch';

const scope = { sessionId: 'light-test', notify: () => {} };

async function setup() {
  store['llm-api-keys'] = {
    providers: {
      ollama: {
        name: 'Ollama',
        type: 'ollama',
        apiKey: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelNames: ['qwen3:8b'],
        createdAt: 1,
      },
      openrouter: {
        name: 'OpenRouter',
        type: 'openrouter',
        // A key the page never sees; plain here (no vault in this test)
        apiKey: 'sk-or-light-test',
        baseUrl: 'https://openrouter.test/api/v1',
        modelNames: ['openai/gpt-5-mini'],
        createdAt: 2,
      },
    },
  };
  const base = { label: '', contextTokens: null, tools: true, health: 'ok' as const, seenAt: 1 };
  await db.modelCatalog.bulkPut([
    {
      ...base,
      id: 'ollama:qwen3:8b',
      providerId: 'ollama',
      model: 'qwen3:8b',
      local: true,
      inputUsdPerM: 0,
      outputUsdPerM: 0,
      modalities: ['chat', 'text'],
    },
    {
      ...base,
      id: 'openrouter:openai/gpt-5-mini',
      providerId: 'openrouter',
      model: 'openai/gpt-5-mini',
      local: false,
      inputUsdPerM: 2,
      outputUsdPerM: 8,
      modalities: ['chat', 'text'],
    },
  ]);
}

beforeEach(async () => {
  for (const key of Object.keys(store)) delete store[key];
  await db.modelCatalog.clear();
  await db.inbox.clear();
  await db.usageEvents.clear();
  forgetLocalChecks();
  resetBreakers();
  await setup();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('chrome', chromeMock);
});
const chromeMock = (globalThis as unknown as { chrome: unknown }).chrome;

describe('light work', () => {
  it('runs on the local model when its server answers', async () => {
    vi.stubGlobal('fetch', fakeFetch({ 'http://127.0.0.1:11434/api/tags': { json: { models: [] } } }).fetch);
    expect(await lightRoute()).toEqual({ route: 'local', target: { providerId: 'ollama', model: 'qwen3:8b' } });
    const { chatModel, local } = await lightModel('summary', scope);
    expect(local).toBe(true);
    expect(chatModel.modelName).toBe('qwen3:8b');
    expect(await db.inbox.count()).toBe(0);
  });

  it('with no local server, says so once in the Inbox, then uses the cloud', async () => {
    vi.stubGlobal('fetch', fakeFetch({ 'http://127.0.0.1:11434/': networkDown }).fetch);
    const first = await lightModel('inbox', scope);
    expect(first.local).toBe(false);
    expect(first.chatModel.modelName).toBe('openai/gpt-5-mini');
    const items = await db.inbox.toArray();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: 'models', kind: 'alert', title: 'models_light_notice_title' });
    expect((await modelSettingsStore.getSettings()).lightNoticeAt).not.toBeNull();

    forgetLocalChecks();
    await lightModel('inbox', scope);
    expect(await db.inbox.count()).toBe(1);
  });

  it('uses the cloud quietly when the user allowed it or prefers the cloud', async () => {
    vi.stubGlobal('fetch', fakeFetch({ 'http://127.0.0.1:11434/': networkDown }).fetch);
    await modelSettingsStore.updateSettings({ lightCloudAllowed: true });
    expect((await lightModel('routine', scope)).local).toBe(false);
    await modelSettingsStore.updateSettings({ lightCloudAllowed: false, preferLocalLight: false });
    expect(await lightRoute()).toMatchObject({ route: 'cloud', reason: 'preferCloud' });
    expect(await db.inbox.count()).toBe(0);
  });

  it('counts what running locally saved, at the price of the cloud model it replaced', async () => {
    const event = await recordUsage('light-test', 'qwen3:8b', 1_000_000, 0, {
      providerId: 'ollama',
      role: 'local',
      light: true,
      savedAgainst: { providerId: 'openrouter', model: 'openai/gpt-5-mini' },
    });
    expect(event.costUsd).toBe(0);
    expect(event.light).toBe(true);
    expect(event.savedUsd).toBeCloseTo(2);
  });
});

describe('a local server answers', () => {
  it('when it lists models, or has no list (404), but not when it refuses the extension (403)', async () => {
    for (const [status, expected] of [
      [200, 'local'],
      [404, 'local'],
      [403, 'cloud'],
    ] as const) {
      forgetLocalChecks();
      resetBreakers();
      const answer = { status, json: status === 200 ? { models: [] } : {} };
      vi.stubGlobal('fetch', fakeFetch({ 'http://127.0.0.1:11434/api/tags': answer }).fetch);
      expect((await lightRoute()).route).toBe(expected);
    }
  });
});
