import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ava Copilot with no cloud at all: only Ollama, with qwen3:4b and nomic-embed-text. A chat answer, light work (a
 * title, a summary) and the fallback path all run on it, and every model request goes to the local server only.
 */

const store = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[] | string | null) =>
          keys === null
            ? structuredClone(data)
            : Object.fromEntries(
                (Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, structuredClone(data[k])]),
              ),
        set: async (items: Record<string, unknown>) => Object.assign(data, structuredClone(items)),
        remove: async () => undefined,
        onChanged: { addListener: () => undefined },
      },
      session: { get: async () => ({}), set: async () => undefined },
    },
  });
  return data;
});

vi.mock('@extension/i18n', () => ({ t: (key: string) => key }));

const { db } = await import('@extension/storage');
const { forgetLocalChecks, lightModel, lightRoute } = await import('../light');
const { createRoleModel } = await import('../roles');
const { fallbackChatModel } = await import('../fallback');
const { resetBreakers } = await import('../breakers');
const { generatePlainText } = await import('../../llm/generate');

const scope = { sessionId: 'local-only-test', notify: () => {} };
const OLLAMA = 'http://127.0.0.1:11434';

/** A stand-in for Ollama: its model list, and OpenAI-style chat answers on /v1. */
function mockOllama({ up = true } = {}) {
  const requests: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (!up || !url.startsWith(OLLAMA)) throw new TypeError('Failed to fetch');
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.startsWith(`${OLLAMA}/api/tags`)) {
      return json({ models: [{ name: 'qwen3:4b' }, { name: 'nomic-embed-text:latest' }] });
    }
    if (url.startsWith(`${OLLAMA}/v1/chat/completions`)) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model: string };
      return json({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: `local answer from ${body.model}` },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

const say = (text: string) => [{ role: 'user' as const, content: text }];

beforeEach(async () => {
  for (const key of Object.keys(store)) delete store[key];
  store['llm-api-keys'] = {
    providers: {
      ollama: {
        name: 'Ollama',
        type: 'ollama',
        apiKey: 'ollama',
        baseUrl: `${OLLAMA}/v1`,
        modelNames: ['qwen3:4b'],
        createdAt: 1,
      },
    },
  };
  store['agent-models'] = {
    agents: {
      navigator: { provider: 'ollama', modelName: 'qwen3:4b' },
      planner: { provider: 'ollama', modelName: 'qwen3:4b' },
    },
  };
  await db.modelCatalog.clear();
  await db.inbox.clear();
  await db.usageEvents.clear();
  await db.modelCatalog.put({
    id: 'ollama:qwen3:4b',
    providerId: 'ollama',
    model: 'qwen3:4b',
    label: '',
    local: true,
    contextTokens: null,
    tools: true,
    health: 'ok',
    seenAt: 1,
    inputUsdPerM: 0,
    outputUsdPerM: 0,
    modalities: ['chat', 'text'],
  });
  forgetLocalChecks();
  resetBreakers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('chrome', chromeMock);
});
const chromeMock = (globalThis as unknown as { chrome: unknown }).chrome;

describe('local models only (no cloud key)', () => {
  it('answers a chat on qwen3:4b, through Ollama alone', async () => {
    const ollama = mockOllama();
    vi.stubGlobal('fetch', ollama.fetch);
    const { chatModel, choice } = await createRoleModel('fast', scope);
    expect(choice).toMatchObject({ providerId: 'ollama', model: 'qwen3:4b', local: true });
    const text = await generatePlainText({ chatModel, messages: say('Hello') });
    expect(text).toBe('local answer from qwen3:4b');
    expect(ollama.requests.every(url => url.startsWith(OLLAMA))).toBe(true);
    // A local model gets no cloud fallback of its own
    expect(chatModel.fallback).toBeUndefined();
  });

  it('runs light work (a title, a summary) on the local model, with no notice', async () => {
    const ollama = mockOllama();
    vi.stubGlobal('fetch', ollama.fetch);
    expect(await lightRoute()).toEqual({ route: 'local', target: { providerId: 'ollama', model: 'qwen3:4b' } });
    for (const task of ['title', 'summary'] as const) {
      const { chatModel, local } = await lightModel(task, scope);
      expect(local).toBe(true);
      expect(await generatePlainText({ chatModel, messages: say(`Make a ${task}`) })).toBe(
        'local answer from qwen3:4b',
      );
    }
    expect(await db.inbox.count()).toBe(0);
    const usage = await db.usageEvents.toArray();
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every(event => event.providerId === 'ollama' && event.costUsd === 0)).toBe(true);
  });

  it('finds the local fallback model for a failed cloud call', async () => {
    vi.stubGlobal('fetch', mockOllama().fetch);
    const fallback = await fallbackChatModel(scope);
    expect(fallback?.modelName).toBe('qwen3:4b');
    expect(await generatePlainText({ chatModel: fallback!, messages: say('Finish it') })).toBe(
      'local answer from qwen3:4b',
    );
  });

  it('with Ollama stopped, the call fails with a plain error instead of reaching for a cloud', async () => {
    const ollama = mockOllama({ up: false });
    vi.stubGlobal('fetch', ollama.fetch);
    expect(await fallbackChatModel(scope)).toBeNull();
    const { chatModel } = await lightModel('title', scope);
    await expect(generatePlainText({ chatModel, messages: say('Make a title') })).rejects.toThrow();
    expect(ollama.requests.every(url => url.startsWith(OLLAMA))).toBe(true);
  });
});
