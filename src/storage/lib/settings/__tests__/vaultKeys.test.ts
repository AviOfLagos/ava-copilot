import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const {
  hasPlaintextKeys,
  keysMigratedAt,
  llmProviderStore,
  migrateProviderKeys,
  providerHasKey,
  providerIsUsable,
  providerKeyRef,
} = await import('../llmProviders');
const { secretVault } = await import('../../secrets');

const OPENAI_KEY = 'sk-openai-0123456789wxyz';
const GEMINI_KEY = 'AIza-gemini-0123456789abcd';

type Providers = Record<string, Record<string, unknown>>;
const saved = () => (store['llm-api-keys'] as { providers: Providers }).providers;

/** Runs the callback as an extension page would: with a window, so nothing is decrypted. */
async function asPage<T>(work: () => Promise<T>): Promise<T> {
  vi.stubGlobal('window', {});
  try {
    return await work();
  } finally {
    vi.unstubAllGlobals();
    // unstubAllGlobals also removes chrome; put it back
    vi.stubGlobal('chrome', chromeMock);
  }
}
const chromeMock = (globalThis as unknown as { chrome: unknown }).chrome;

beforeEach(async () => {
  for (const key of Object.keys(store)) delete store[key];
  for (const ref of await secretVault.refs()) await secretVault.delete(ref);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('moving plaintext keys into the vault', () => {
  beforeEach(() => {
    store['llm-api-keys'] = {
      providers: {
        openai: { apiKey: OPENAI_KEY, name: 'OpenAI', type: 'openai', modelNames: ['gpt-6-astra'] },
        gemini: { apiKey: GEMINI_KEY, name: 'Gemini', type: 'gemini', modelNames: ['gemini-3.8-flash'] },
        ollama: { apiKey: 'ollama', name: 'Ollama', type: 'ollama', baseUrl: 'http://localhost:11434/v1' },
        custom_openai_1: { apiKey: '', name: 'Local', type: 'custom_openai', baseUrl: 'http://127.0.0.1:8080/v1' },
      },
    };
  });

  it('writes each key to the vault, checks it reads back, then blanks the plaintext and marks it done', async () => {
    expect(await hasPlaintextKeys()).toBe(true);
    expect(await keysMigratedAt()).toBeNull();

    const result = await migrateProviderKeys();
    expect(result).toEqual({ migrated: ['openai', 'gemini'], failed: [] });

    const json = JSON.stringify(store);
    expect(json).not.toContain(OPENAI_KEY);
    expect(json).not.toContain(GEMINI_KEY);
    expect(saved().openai).toMatchObject({ apiKey: '', hasKey: true, keyLast4: 'wxyz', keyRef: 'llm:openai' });
    expect(saved().gemini).toMatchObject({ apiKey: '', hasKey: true, keyLast4: 'abcd', keyRef: 'llm:gemini' });
    // A local placeholder is no secret, and an empty key stays empty
    expect(saved().ollama).toMatchObject({ apiKey: 'ollama' });
    expect(saved().ollama.hasKey).toBeUndefined();
    expect(await hasPlaintextKeys()).toBe(false);
    expect(await keysMigratedAt()).toEqual(expect.any(Number));

    // The background still gets the keys, transparently
    const providers = await llmProviderStore.getAllProviders();
    expect(providers.openai.apiKey).toBe(OPENAI_KEY);
    expect(providers.gemini.apiKey).toBe(GEMINI_KEY);
    expect(providers.ollama.apiKey).toBe('ollama');
    expect((await llmProviderStore.getProvider('openai'))?.apiKey).toBe(OPENAI_KEY);

    // Running again moves nothing
    expect(await migrateProviderKeys()).toEqual({ migrated: [], failed: [] });
  });

  it('keeps a key that could not be stored where it was, to try again later', async () => {
    const put = secretVault.put.bind(secretVault);
    vi.spyOn(secretVault, 'put').mockImplementation(async (ref, value) => {
      if (ref === providerKeyRef('gemini')) throw new Error('disk full');
      return put(ref, value);
    });
    const result = await migrateProviderKeys();
    expect(result).toEqual({ migrated: ['openai'], failed: ['gemini'] });
    expect(saved().gemini.apiKey).toBe(GEMINI_KEY);
    expect(saved().openai.apiKey).toBe('');
    // Not marked done while a key is still in plaintext
    expect(await keysMigratedAt()).toBeNull();
    expect((await llmProviderStore.getAllProviders()).gemini.apiKey).toBe(GEMINI_KEY);
  });

  it('never lets a page see a key, saved in the vault or not yet moved', async () => {
    await migrateProviderKeys();
    store['llm-api-keys'] = {
      providers: { ...saved(), grok: { apiKey: 'xai-plaintext-123456789', name: 'Grok', type: 'grok' } },
    };
    const providers = await asPage(() => llmProviderStore.getAllProviders());
    expect(providers.openai.apiKey).toBe('••••wxyz');
    expect(providers.grok.apiKey).toBe('••••6789');
    expect(providers.ollama.apiKey).toBe('ollama');
    expect(providers.custom_openai_1.apiKey).toBe('');
    expect(JSON.stringify(providers)).not.toContain('xai-plaintext');
    // The panel's "has a key" check keeps working on the masked value, and on hasKey
    expect(providerHasKey(providers.openai)).toBe(true);
    expect(providers.openai.apiKey.trim() !== '').toBe(true);
    expect(providerIsUsable(providers.custom_openai_1, 'custom_openai_1')).toBe(true);

    const summaries = await llmProviderStore.getProviderSummaries();
    expect(summaries.openai.apiKey).toBe('••••wxyz');
    await expect(asPage(() => migrateProviderKeys())).rejects.toThrow(/background/);
  });
});

describe('saving a provider', () => {
  it('puts a new key in the vault, keeps it when the key is left empty or masked, and removes it on request', async () => {
    await llmProviderStore.setProvider('openai', { apiKey: OPENAI_KEY, name: 'OpenAI', type: 'openai' as never });
    expect(JSON.stringify(store)).not.toContain(OPENAI_KEY);
    expect(await secretVault.get('llm:openai')).toBe(OPENAI_KEY);
    expect(saved().openai).toMatchObject({ hasKey: true, keyLast4: 'wxyz' });

    // Changing other settings keeps the key
    await llmProviderStore.setProvider('openai', {
      apiKey: '',
      name: 'OpenAI',
      type: 'openai' as never,
      modelNames: ['gpt-6-luna'],
    });
    await llmProviderStore.setProvider('openai', { apiKey: '••••wxyz', name: 'OpenAI', type: 'openai' as never });
    expect((await llmProviderStore.getProvider('openai'))?.apiKey).toBe(OPENAI_KEY);

    // A new key replaces it
    await llmProviderStore.setProvider('openai', { apiKey: 'sk-second-key-000011112222', type: 'openai' as never });
    expect((await llmProviderStore.getProvider('openai'))?.apiKey).toBe('sk-second-key-000011112222');
    expect(saved().openai.keyLast4).toBe('2222');

    // A provider that needs a key cannot drop it
    await expect(
      llmProviderStore.setProvider('openai', { apiKey: '', hasKey: false, type: 'openai' as never }),
    ).rejects.toThrow(/API Key is required/);
  });

  it('removes the key of a provider that can run without one, and the vault entry with the provider', async () => {
    await llmProviderStore.setProvider('custom_openai_1', {
      apiKey: 'custom-secret-key-778899',
      name: 'Mine',
      type: 'custom_openai' as never,
      baseUrl: 'https://example.test/v1',
    });
    expect(await secretVault.has('llm:custom_openai_1')).toBe(true);
    await llmProviderStore.setProvider('custom_openai_1', {
      apiKey: '',
      hasKey: false,
      name: 'Mine',
      type: 'custom_openai' as never,
      baseUrl: 'https://example.test/v1',
    });
    expect(await secretVault.has('llm:custom_openai_1')).toBe(false);
    expect(saved().custom_openai_1).toMatchObject({ apiKey: '', hasKey: false });

    await llmProviderStore.setProvider('nvidia', { apiKey: 'nvapi-0000111122223333', type: 'nvidia' as never });
    await llmProviderStore.removeProvider('nvidia');
    expect(await secretVault.has('llm:nvidia')).toBe(false);
    expect(saved().nvidia).toBeUndefined();
  });

  it('refuses a new key from a page, which has no business holding it', async () => {
    await expect(
      asPage(() => llmProviderStore.setProvider('openai', { apiKey: OPENAI_KEY, type: 'openai' as never })),
    ).rejects.toThrow(/background/);
    expect(JSON.stringify(store)).not.toContain(OPENAI_KEY);
  });

  it('stops showing a key the vault lost, so the user enters it again', async () => {
    await llmProviderStore.setProvider('openai', { apiKey: OPENAI_KEY, type: 'openai' as never });
    await secretVault.delete('llm:openai');
    expect((await llmProviderStore.getAllProviders()).openai.apiKey).toBe('');
    expect(saved().openai.hasKey).toBe(false);
  });
});
