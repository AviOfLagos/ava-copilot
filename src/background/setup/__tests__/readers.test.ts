import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `chrome-extension://ext/${path}`, id: 'ext' },
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

const { readLocal } = await import('../readers');

function server(models: string[] | null, root = 'http://localhost:11434') {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (models === null || !url.startsWith(`${root}/api/tags`)) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify({ models: models.map(name => ({ name })) }), { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
});

describe('the local model reading', () => {
  it('finds Ollama on its usual port before it is added in Models', async () => {
    const reading = await readLocal(server(['qwen3:4b', 'nomic-embed-text:latest']));
    expect(reading).toMatchObject({
      kind: 'ollama',
      saved: false,
      answers: true,
      chatModels: ['qwen3:4b'],
      embed: true,
    });
  });

  it('reads the saved Ollama at its own address', async () => {
    store['llm-api-keys'] = {
      providers: {
        ollama: {
          name: 'Ollama',
          type: 'ollama',
          apiKey: 'ollama',
          baseUrl: 'http://127.0.0.1:11500/v1',
          createdAt: 1,
        },
      },
    };
    const reading = await readLocal(server(['gemma3:4b'], 'http://127.0.0.1:11500'));
    expect(reading).toMatchObject({ providerId: 'ollama', saved: true, answers: true, embed: false });
  });

  it('nothing answering', async () => {
    const reading = await readLocal(server(null));
    expect(reading).toMatchObject({ answers: false, saved: false, chatModels: [] });
  });
});
