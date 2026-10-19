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

// Messages come back as "key|arg1|arg2", so the note's parts can be checked
vi.mock('@extension/i18n', () => ({
  t: (key: string, args?: string[]) => [key, ...(args ?? [])].join('|'),
}));

const { db, modelSettingsStore } = await import('@extension/storage');
const { forgetLocalChecks } = await import('../light');
const { createRoleModel } = await import('../roles');
const { fallbackChatModel } = await import('../fallback');
const { generatePlainText } = await import('../../llm/generate');
const { systemMessage, userMessage } = await import('../../llm/messages');
const { resetBreakers } = await import('../breakers');
import { fakeFetch, networkDown } from './fakeFetch';

const OLLAMA = 'http://127.0.0.1:11434';
const CLOUD = 'https://openrouter.test/api/v1';
const messages = [systemMessage('system'), userMessage('task')];

const completion = (text: string) => ({
  json: {
    id: 'c1',
    object: 'chat.completion',
    created: 1,
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  },
});

// The usage meter retries a 429 after the server's Retry-After; a tiny one keeps the test fast
const quotaSpent = {
  status: 429,
  headers: { 'retry-after': '0.001' },
  json: { error: { message: 'You exceeded your current quota', code: 429 } },
};

async function setup() {
  store['llm-api-keys'] = {
    providers: {
      ollama: {
        name: 'Ollama',
        type: 'ollama',
        apiKey: 'ollama',
        baseUrl: `${OLLAMA}/v1`,
        modelNames: ['qwen3:4b', 'gemma4:12b'],
        createdAt: 1,
      },
      openrouter: {
        name: 'OpenRouter',
        type: 'openrouter',
        apiKey: 'sk-or-fallback-test',
        baseUrl: CLOUD,
        modelNames: ['openai/gpt-5-mini'],
        createdAt: 2,
      },
    },
  };
  // The cloud model is the one chosen for fast work
  await modelSettingsStore.setRole('fast', { providerId: 'openrouter', model: 'openai/gpt-5-mini' });
  const base = { label: '', contextTokens: null, tools: true, health: 'ok' as const, seenAt: 1 };
  await db.modelCatalog.bulkPut([
    {
      ...base,
      id: 'ollama:qwen3:4b',
      providerId: 'ollama',
      model: 'qwen3:4b',
      local: true,
      inputUsdPerM: 0,
      outputUsdPerM: 0,
      modalities: ['chat', 'text'],
    },
    {
      ...base,
      id: 'ollama:gemma4:12b',
      providerId: 'ollama',
      model: 'gemma4:12b',
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

const chromeMock = (globalThis as unknown as { chrome: unknown }).chrome;

beforeEach(async () => {
  for (const key of Object.keys(store)) delete store[key];
  await db.modelCatalog.clear();
  await db.usageEvents.clear();
  forgetLocalChecks();
  resetBreakers();
  await setup();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('chrome', chromeMock);
});

describe('a cloud call that fails finishes on the local model', () => {
  it('after the meter’s retries, with a note in the chat and the usage counted for the local model', async () => {
    const { fetch, requests } = fakeFetch({
      [`${CLOUD}/chat/completions`]: quotaSpent,
      [`${OLLAMA}/api/tags`]: { json: { models: [] } },
      [`${OLLAMA}/v1/chat/completions`]: completion('done locally'),
    });
    vi.stubGlobal('fetch', fetch);
    const notify = vi.fn();
    const { chatModel, choice } = await createRoleModel('fast', { sessionId: 'fallback-test', notify });
    expect(choice).toMatchObject({ providerId: 'openrouter', local: false });

    expect(await generatePlainText({ chatModel, messages })).toBe('done locally');
    // The first try and the meter's four retries, then one call on the local model
    expect(requests.filter(request => request.url.startsWith(CLOUD))).toHaveLength(5);
    expect(requests.filter(request => request.url === `${OLLAMA}/v1/chat/completions`)).toHaveLength(1);
    const notes = notify.mock.calls.map(([message]) => message as string).filter(m => m.startsWith('models_fallback'));
    expect(notes).toEqual(['models_fallback_note|OpenRouter|models_fallback_reason_quota|gemma4:12b']);

    const events = await db.usageEvents.toArray();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ providerId: 'ollama', model: 'gemma4:12b', role: 'fast', costUsd: 0 });
  });

  it('uses the model chosen in “When the cloud fails”', async () => {
    await modelSettingsStore.updateSettings({
      fallbackLocal: { enabled: true, model: { providerId: 'ollama', model: 'qwen3:4b' } },
    });
    vi.stubGlobal('fetch', fakeFetch({ [`${OLLAMA}/api/tags`]: { json: { models: [] } } }).fetch);
    const local = await fallbackChatModel({ sessionId: 's', notify: () => {} });
    expect(local?.modelName).toBe('qwen3:4b');
  });

  it('does nothing when turned off or when the local server does not answer', async () => {
    const answer = vi.fn(() => completion('should not be asked'));
    const cloudDown = { status: 401, json: { error: { message: 'bad key' } } };

    await modelSettingsStore.updateSettings({ fallbackLocal: { enabled: false, model: null } });
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        [`${CLOUD}/chat/completions`]: cloudDown,
        [`${OLLAMA}/api/tags`]: { json: { models: [] } },
        [`${OLLAMA}/v1/chat/completions`]: async () => new Response(JSON.stringify(answer().json)),
      }).fetch,
    );
    const off = await createRoleModel('fast', { sessionId: 's', notify: () => {} });
    await expect(generatePlainText({ chatModel: off.chatModel, messages })).rejects.toThrow();
    expect(answer).not.toHaveBeenCalled();

    await modelSettingsStore.updateSettings({ fallbackLocal: { enabled: true, model: null } });
    forgetLocalChecks();
    vi.stubGlobal('fetch', fakeFetch({ [`${CLOUD}/chat/completions`]: cloudDown, [`${OLLAMA}/`]: networkDown }).fetch);
    const stopped = await createRoleModel('fast', { sessionId: 's', notify: () => {} });
    await expect(generatePlainText({ chatModel: stopped.chatModel, messages })).rejects.toThrow();
  });

  it('never gives the embedding or the local role a fallback', async () => {
    await modelSettingsStore.setRole('embed', { providerId: 'openrouter', model: 'openai/gpt-5-mini' });
    const embed = await createRoleModel('embed', { sessionId: 's', notify: () => {} });
    expect(embed.chatModel.fallback).toBeUndefined();
    const local = await createRoleModel('local', { sessionId: 's', notify: () => {} });
    expect(local.chatModel.fallback).toBeUndefined();
    const fast = await createRoleModel('fast', { sessionId: 's', notify: () => {} });
    expect(fast.chatModel.fallback).toBeDefined();
  });
});
