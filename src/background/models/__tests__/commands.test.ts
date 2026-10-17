import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@extension/i18n', () => ({ t: (key: string) => key }));

const { agentModelStore, db, llmProviderStore, modelHealthStore, modelSettingsStore, secretVault } =
  await import('@extension/storage');
const { dispatchCommand } = await import('../../registry');
// Registers the models_ commands and job handlers
await import('../register');
const { resolveRole } = await import('../roles');
const { resetBreakers } = await import('../breakers');
import { fakeFetch } from './fakeFetch';

const GEMINI_KEY = 'AIza-command-key-0000abcd';

/** Sends a command as the panel would, and returns its reply. */
async function send(message: Record<string, unknown>) {
  const replies: Record<string, unknown>[] = [];
  const handled = await dispatchCommand(message as never, {
    reply: reply => void replies.push(reply),
    requestId: 'r1',
  });
  expect(handled).toBe(true);
  return replies[0];
}

beforeEach(async () => {
  for (const key of Object.keys(store)) delete store[key];
  for (const ref of await secretVault.refs()) await secretVault.delete(ref);
  await db.modelCatalog.clear();
  resetBreakers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('chrome', chromeMock);
});
const chromeMock = (globalThis as unknown as { chrome: unknown }).chrome;

describe('models_provider_save', () => {
  it('saves the key to the vault, lists the models, assigns Gemini defaults, and never echoes the key', async () => {
    const { fetch, requests } = fakeFetch({
      'https://generativelanguage.googleapis.com/v1beta/models': {
        json: {
          models: [
            { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.1-pro-preview', supportedGenerationMethods: ['generateContent'] },
          ],
        },
      },
    });
    vi.stubGlobal('fetch', fetch);

    const reply = await send({
      type: 'models_provider_save',
      providerId: 'gemini',
      config: { type: 'gemini', name: 'Gemini', modelNames: ['gemini-3.8-flash', 'gemini-3.1-pro-preview'] },
      apiKey: GEMINI_KEY,
    });

    expect(reply).toMatchObject({
      type: 'models_provider_saved',
      requestId: 'r1',
      providerId: 'gemini',
      hasKey: true,
      keyLast4: 'abcd',
      models: 2,
      health: { status: 'ok' },
    });
    expect(JSON.stringify(reply)).not.toContain(GEMINI_KEY);
    expect(JSON.stringify(store)).not.toContain(GEMINI_KEY);
    expect(requests[0].headers.get('x-goog-api-key')).toBe(GEMINI_KEY);
    expect(await db.modelCatalog.where('providerId').equals('gemini').count()).toBe(2);
    expect(await agentModelStore.getAgentModel('navigator' as never)).toMatchObject({ modelName: 'gemini-3.8-flash' });
    expect(await agentModelStore.getAgentModel('planner' as never)).toMatchObject({
      modelName: 'gemini-3.1-pro-preview',
    });
  });

  it('answers a refused key with its health, and assigns no defaults', async () => {
    vi.stubGlobal('fetch', fakeFetch({ 'https://generativelanguage.googleapis.com/': { status: 400 } }).fetch);
    const reply = await send({
      type: 'models_provider_save',
      providerId: 'gemini',
      config: { type: 'gemini', modelNames: ['gemini-3.8-flash'] },
      apiKey: 'AIza-wrong-key-1234567',
    });
    expect(reply).toMatchObject({ health: { status: 'error', hint: 'key_rejected' } });
    expect(await agentModelStore.getAgentModel('navigator' as never)).toBeUndefined();
  });

  it('refuses input that does not fit: an odd provider id, a non-web address, an unknown kind', async () => {
    for (const bad of [
      { providerId: '../etc', config: { type: 'openai' } },
      { providerId: 'custom_openai_1', config: { type: 'custom_openai', baseUrl: 'javascript:alert(1)' } },
      { providerId: 'groq', config: { type: 'groq' } },
    ]) {
      expect(await send({ type: 'models_provider_save', ...bad })).toMatchObject({ type: 'error', requestId: 'r1' });
    }
    expect(store['llm-api-keys']).toBeUndefined();
  });

  it('reports a save the store refuses, in plain words', async () => {
    const reply = await send({ type: 'models_provider_save', providerId: 'openai', config: { type: 'openai' } });
    expect(reply).toMatchObject({ type: 'error', error: expect.stringMatching(/API Key is required/) });
  });
});

describe('models_provider_check and models_provider_remove', () => {
  it('tries a draft key without saving it, and removes a provider with its key, models and health', async () => {
    const { fetch, requests } = fakeFetch({
      'https://integrate.api.nvidia.com/v1/models': { json: { data: [{ id: 'meta/llama-3.3-70b-instruct' }] } },
    });
    vi.stubGlobal('fetch', fetch);
    const draft = await send({
      type: 'models_provider_check',
      providerId: 'nvidia',
      config: { type: 'nvidia', baseUrl: 'https://integrate.api.nvidia.com/v1' },
      apiKey: 'nvapi-draft-000011112222',
    });
    expect(draft).toMatchObject({
      type: 'models_provider_checked',
      models: 1,
      sample: ['meta/llama-3.3-70b-instruct'],
    });
    expect(requests[0].headers.get('authorization')).toBe('Bearer nvapi-draft-000011112222');
    // Only tried: nothing saved, nothing listed
    expect(await llmProviderStore.hasProvider('nvidia')).toBe(false);
    expect(await db.modelCatalog.count()).toBe(0);

    await send({
      type: 'models_provider_save',
      providerId: 'nvidia',
      config: { type: 'nvidia', baseUrl: 'https://integrate.api.nvidia.com/v1' },
      apiKey: 'nvapi-draft-000011112222',
    });
    expect(await secretVault.has('llm:nvidia')).toBe(true);
    expect(await db.modelCatalog.count()).toBe(1);

    expect(await send({ type: 'models_provider_remove', providerId: 'nvidia' })).toMatchObject({
      type: 'models_provider_removed',
    });
    expect(await secretVault.has('llm:nvidia')).toBe(false);
    expect(await db.modelCatalog.count()).toBe(0);
    expect((await modelHealthStore.getHealth()).providers.nvidia).toBeUndefined();
  });
});

describe('resolveRole', () => {
  it('reads the stores and pins the first automatic embedding model', async () => {
    await llmProviderStore.setProvider('ollama', {
      apiKey: 'ollama',
      type: 'ollama' as never,
      baseUrl: 'http://localhost:11434/v1',
    });
    await db.modelCatalog.bulkPut([
      {
        id: 'ollama:nomic-embed-text',
        providerId: 'ollama',
        model: 'nomic-embed-text',
        label: 'nomic-embed-text',
        local: true,
        contextTokens: null,
        inputUsdPerM: 0,
        outputUsdPerM: 0,
        modalities: ['embedding', 'text'],
        tools: null,
        health: 'ok',
        seenAt: 1,
      },
    ]);
    expect(await resolveRole('embed')).toMatchObject({
      providerId: 'ollama',
      model: 'nomic-embed-text',
      source: 'auto',
    });
    expect((await modelSettingsStore.getSettings()).pinnedEmbed).toEqual({
      providerId: 'ollama',
      model: 'nomic-embed-text',
    });
    expect(await resolveRole('embed')).toMatchObject({ source: 'pinned' });
    await expect(resolveRole('tts')).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('a saved key stays with its server', () => {
  it('is never sent to a new address, in a check or a save', async () => {
    const { fetch, requests } = fakeFetch({
      'https://good.example/v1/models': { json: { data: [{ id: 'm1' }] } },
      'https://evil.example/v1/models': { json: { data: [{ id: 'x' }] } },
    });
    vi.stubGlobal('fetch', fetch);
    await send({
      type: 'models_provider_save',
      providerId: 'custom_good',
      config: { type: 'custom_openai', name: 'Good', baseUrl: 'https://good.example/v1', modelNames: ['m1'] },
      apiKey: 'sk-good-1234',
    });

    // A draft pointing elsewhere is tried without the saved key
    await send({
      type: 'models_provider_check',
      providerId: 'custom_good',
      config: { type: 'custom_openai', name: 'Good', baseUrl: 'https://evil.example/v1', modelNames: ['m1'] },
    });
    const toEvil = requests.filter(request => request.url.startsWith('https://evil.example'));
    expect(toEvil.length).toBeGreaterThan(0);
    for (const request of toEvil) expect(request.headers.get('authorization') ?? '').not.toContain('sk-good-1234');

    // Saving the new address without typing the key again is refused
    const reply = await send({
      type: 'models_provider_save',
      providerId: 'custom_good',
      config: { type: 'custom_openai', name: 'Good', baseUrl: 'https://evil.example/v1', modelNames: ['m1'] },
    });
    expect(reply).toMatchObject({ type: 'error' });
    expect(String(reply.error)).toMatch(/address changed/);
    expect((await llmProviderStore.getProvider('custom_good'))?.baseUrl).toBe('https://good.example/v1');
  });
});

describe('role defaults for any provider', () => {
  it('gives an OpenAI key the best listed models, turning them on when the saved suggestions are not offered', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        'https://api.openai.com/v1/models': {
          json: { data: [{ id: 'gpt-7-pro' }, { id: 'gpt-7-mini' }, { id: 'text-embedding-3-small' }] },
        },
      }).fetch,
    );
    const reply = await send({
      type: 'models_provider_save',
      providerId: 'openai',
      config: { type: 'openai', name: 'OpenAI', modelNames: ['gpt-6-astra'] },
      apiKey: 'sk-openai-test-1234',
    });
    expect(reply).toMatchObject({ health: { status: 'ok' }, assigned: { planner: { modelName: 'gpt-7-pro' } } });
    expect(await agentModelStore.getAgentModel('planner' as never)).toMatchObject({ modelName: 'gpt-7-pro' });
    expect(await agentModelStore.getAgentModel('navigator' as never)).toMatchObject({ modelName: 'gpt-7-mini' });
    expect((await llmProviderStore.getProvider('openai'))?.modelNames).toContain('gpt-7-pro');
    expect((await modelSettingsStore.getSettings()).roles.fast).toEqual({ providerId: 'openai', model: 'gpt-7-mini' });
  });

  it('gives a local Ollama its chat model for both agents, and leaves a working choice alone afterwards', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        // No /api/show: what each model can do comes from its name
        'http://localhost:11434/api/tags': { json: { models: [{ name: 'qwen3:4b' }, { name: 'nomic-embed-text' }] } },
      }).fetch,
    );
    const reply = await send({
      type: 'models_provider_save',
      providerId: 'ollama',
      config: { type: 'ollama', modelNames: ['qwen3:4b', 'nomic-embed-text'] },
    });
    expect(reply).toMatchObject({ health: { status: 'ok' } });
    expect(await agentModelStore.getAgentModel('navigator' as never)).toEqual({
      provider: 'ollama',
      modelName: 'qwen3:4b',
    });
    expect(await agentModelStore.getAgentModel('planner' as never)).toMatchObject({ modelName: 'qwen3:4b' });

    // A second provider saved later changes nothing that works
    vi.stubGlobal(
      'fetch',
      fakeFetch({ 'http://localhost:1234/v1/models': { json: { data: [{ id: 'llama-4-8b' }] } } }).fetch,
    );
    const second = await send({ type: 'models_provider_save', providerId: 'lmstudio', config: { type: 'lmstudio' } });
    expect(second).toMatchObject({ assigned: {} });
    expect(await agentModelStore.getAgentModel('navigator' as never)).toMatchObject({ provider: 'ollama' });
  });

  it('assigns nothing for a local server that does not answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const reply = await send({ type: 'models_provider_save', providerId: 'ollama', config: { type: 'ollama' } });
    expect(reply).toMatchObject({ health: { status: 'error' }, assigned: {} });
    expect(await agentModelStore.getAgentModel('navigator' as never)).toBeUndefined();
  });
});

describe('models_local_probe', () => {
  it('says which local servers answer now, and records only what changed', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({ 'http://localhost:11434/api/tags': { json: { models: [{ name: 'qwen3:4b' }] } } }).fetch,
    );
    const reply = await send({ type: 'models_local_probe' });
    expect(reply).toMatchObject({
      type: 'models_local_probed',
      local: [
        { kind: 'ollama', status: 'found', models: ['qwen3:4b'] },
        { kind: 'lmstudio', status: 'absent' },
      ],
    });
    const first = (await modelHealthStore.getHealth()).local.ollama;
    expect(first).toMatchObject({ status: 'found' });
    await send({ type: 'models_local_probe' });
    expect((await modelHealthStore.getHealth()).local.ollama?.checkedAt).toBe(first?.checkedAt);
  });
});
