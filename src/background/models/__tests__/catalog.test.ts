import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// base.ts reads globalThis.chrome when it is imported, so the mock must exist before the import
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

const { AviCopilotDb, llmProviderStore, modelHealthStore, modelSettingsStore, secretVault } =
  await import('@extension/storage');
const { refreshCatalog, checkProvider } = await import('../catalog');
const { resetBreakers } = await import('../breakers');
import { fakeFetch, networkDown, quickRetry } from './fakeFetch';

let db: InstanceType<typeof AviCopilotDb>;

beforeEach(async () => {
  for (const key of Object.keys(store)) delete store[key];
  for (const ref of await secretVault.refs()) await secretVault.delete(ref);
  resetBreakers();
  db = new AviCopilotDb(`catalog-${crypto.randomUUID()}`);
});

const list = (...ids: string[]) => ({ json: { data: ids.map(id => ({ id })) } });

describe('refreshCatalog', () => {
  beforeEach(async () => {
    await llmProviderStore.setProvider('gemini', { apiKey: 'AIza-real-key-12345678', type: 'gemini' as never });
    await llmProviderStore.setProvider('ollama', {
      apiKey: 'ollama',
      type: 'ollama' as never,
      baseUrl: 'http://localhost:11434/v1',
    });
    await llmProviderStore.setProvider('nvidia', { apiKey: 'nvapi-real-key-87654321', type: 'nvidia' as never });
    await llmProviderStore.setProvider('custom_openai_1', {
      apiKey: '',
      type: 'custom_openai' as never,
      baseUrl: 'http://127.0.0.1:9999/v1',
      name: 'Bare',
    });
  });

  it('lists every provider with its decrypted key, prices what it can, and records health', async () => {
    const { fetch, requests } = fakeFetch({
      'https://generativelanguage.googleapis.com/v1beta/models': {
        json: { models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }] },
      },
      'http://localhost:11434/api/tags': { json: { models: [{ name: 'qwen3.8:8b' }] } },
      'http://localhost:11434/api/show': { status: 404 },
      'https://integrate.api.nvidia.com/v1/models': list('meta/llama-3.3-70b-instruct'),
      // A server without a model list
      'http://127.0.0.1:9999/v1/models': { status: 404 },
    });
    const now = new Date(2026, 9, 12, 9).getTime();
    await refreshCatalog({ fetch, db, now: () => now, retryPolicy: quickRetry });

    // The keys reached their own providers only
    expect(requests.find(request => request.url.includes('generativelanguage'))?.headers.get('x-goog-api-key')).toBe(
      'AIza-real-key-12345678',
    );
    expect(requests.find(request => request.url.includes('nvidia'))?.headers.get('authorization')).toBe(
      'Bearer nvapi-real-key-87654321',
    );
    expect(requests.find(request => request.url.includes('11434'))?.headers.get('authorization')).toBeNull();

    const entries = Object.fromEntries((await db.modelCatalog.toArray()).map(entry => [entry.id, entry]));
    expect(entries['gemini:gemini-3.8-flash']).toMatchObject({ inputUsdPerM: 0.75, outputUsdPerM: 3.75, local: false });
    expect(entries['ollama:qwen3.8:8b']).toMatchObject({
      local: true,
      inputUsdPerM: 0,
      outputUsdPerM: 0,
      health: 'ok',
    });
    expect(entries['nvidia:meta/llama-3.3-70b-instruct']).toMatchObject({ inputUsdPerM: null, seenAt: now });

    const health = await modelHealthStore.getHealth();
    expect(health.lastRefreshAt).toBe(now);
    expect(health.providers.gemini).toMatchObject({ status: 'ok', models: 1 });
    // No model list is not the same as down
    expect(health.providers.custom_openai_1).toMatchObject({ status: 'unknown', errorKind: 'not_found' });
    // Nothing about keys in the health record
    expect(JSON.stringify(health)).not.toMatch(/AIza|nvapi/);

    // Providers listed with no models chosen get a sensible few turned on, keys untouched
    const providers = await llmProviderStore.getProviderSummaries();
    expect(providers.ollama.modelNames).toEqual(['qwen3.8:8b']);
    expect(providers.nvidia.modelNames).toEqual(['meta/llama-3.3-70b-instruct']);
    expect(providers.gemini.modelNames).toContain('gemini-3.8-flash');
    expect(providers.gemini.hasKey).toBe(true);
    expect(providers.custom_openai_1.modelNames ?? []).toEqual([]);
  });

  it('keeps a failing provider’s models, marked, with a hint; drops removed providers', async () => {
    const answering = fakeFetch({
      'https://integrate.api.nvidia.com/v1/models': list('meta/llama-3.3-70b-instruct', 'old-model'),
      'http://localhost:11434/api/tags': { json: { models: [{ name: 'qwen3.8:8b' }] } },
    });
    await refreshCatalog({ fetch: answering.fetch, db, retryPolicy: quickRetry, providerIds: ['nvidia', 'ollama'] });
    expect(await db.modelCatalog.where('providerId').equals('nvidia').count()).toBe(2);

    // NVIDIA refuses the key; Ollama refuses the extension's origin
    const refusing = fakeFetch({
      'https://integrate.api.nvidia.com/v1/models': { status: 401 },
      'http://localhost:11434/api/tags': { status: 403 },
    });
    await refreshCatalog({ fetch: refusing.fetch, db, retryPolicy: quickRetry, providerIds: ['nvidia', 'ollama'] });
    const nvidia = await db.modelCatalog.where('providerId').equals('nvidia').toArray();
    expect(nvidia.map(entry => entry.health)).toEqual(['error', 'error']);
    const health = await modelHealthStore.getHealth();
    expect(health.providers.nvidia).toMatchObject({ status: 'error', hint: 'key_rejected', errorKind: 'auth' });
    expect(health.providers.ollama).toMatchObject({ status: 'error', hint: 'ollama_origins' });

    // The provider answers again with fewer models: the list is replaced
    await refreshCatalog({
      fetch: fakeFetch({ 'https://integrate.api.nvidia.com/v1/models': list('meta/llama-3.3-70b-instruct') }).fetch,
      db,
      retryPolicy: quickRetry,
      providerIds: ['nvidia'],
    });
    expect((await db.modelCatalog.where('providerId').equals('nvidia').toArray()).map(entry => entry.model)).toEqual([
      'meta/llama-3.3-70b-instruct',
    ]);

    // Removed: its models and health go at the next refresh
    await llmProviderStore.removeProvider('nvidia');
    await refreshCatalog({ fetch: fakeFetch({}).fetch, db, retryPolicy: quickRetry });
    expect(await db.modelCatalog.where('providerId').equals('nvidia').count()).toBe(0);
    expect((await modelHealthStore.getHealth()).providers.nvidia).toBeUndefined();
  });

  it('looks for Ollama and LM Studio on this machine when asked, once', async () => {
    const { fetch } = fakeFetch({
      'http://localhost:11434/api/tags': { json: { models: [{ name: 'llama3.3:70b' }, { name: 'nomic-embed-text' }] } },
      'http://localhost:1234/v1/models': networkDown,
    });
    await refreshCatalog({ fetch, db, retryPolicy: quickRetry, providerIds: [], probeLocal: true });
    const { local } = await modelHealthStore.getHealth();
    expect(local.ollama).toMatchObject({ status: 'found', models: ['llama3.3:70b', 'nomic-embed-text'] });
    expect(local.lmstudio).toMatchObject({ status: 'absent', models: [] });
    expect((await modelSettingsStore.getSettings()).localProbeDone).toBe(true);
  });
});

describe('checkProvider', () => {
  it('needs no call to know a provider without its key cannot answer', async () => {
    const { fetch, requests } = fakeFetch({});
    const check = await checkProvider('openai', { apiKey: '', type: 'openai' as never }, { fetch });
    expect(check.health).toMatchObject({ status: 'error', hint: 'needs_key' });
    expect(requests).toHaveLength(0);
  });

  it('asks Ollama once more after putting the origin rules back when it refused', async () => {
    const { fetch, requests } = fakeFetch({
      'http://localhost:11434/api/tags': [{ status: 403 }, { json: { models: [{ name: 'qwen3.8:8b' }] } }],
      'http://localhost:11434/api/show': { status: 404 },
    });
    const check = await checkProvider(
      'ollama',
      { apiKey: '', type: 'ollama' as never, baseUrl: 'http://localhost:11434/v1' },
      { fetch, retryPolicy: quickRetry },
    );
    expect(check.health).toMatchObject({ status: 'ok' });
    expect(requests.filter(request => request.url.endsWith('/api/tags'))).toHaveLength(2);
  });

  it('reports a network failure as unreachable', async () => {
    const { fetch } = fakeFetch({ 'http://localhost:1234/': networkDown });
    const check = await checkProvider(
      'lmstudio',
      { apiKey: 'lm-studio', type: 'lmstudio' as never },
      {
        fetch,
        retryPolicy: quickRetry,
      },
    );
    expect(check.health).toMatchObject({ status: 'error', hint: 'unreachable', errorKind: 'network' });
  });
});
