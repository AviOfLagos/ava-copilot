import { describe, expect, it, vi } from 'vitest';

// The settings modules read globalThis.chrome when they are imported
vi.hoisted(() => {
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: async () => ({}), set: async () => undefined, onChanged: { addListener: () => undefined } },
    },
  });
});

const { TAG } = await import('../capabilities');
const { pickRoleModel } = await import('../roles');
const { localChatModels, pickFallbackModel } = await import('../fallback');
const { DEFAULT_MODEL_SETTINGS, modelSettingsStore } = await import('../settings');
import type { ModelCatalogEntry } from '../types';
import type { ProviderConfig } from '../../settings/llmProviders';
import type { ModelSettingsRecord } from '../settings';

const entry = (providerId: string, model: string, local: boolean, extra: Partial<ModelCatalogEntry> = {}) =>
  ({
    id: `${providerId}:${model}`,
    providerId,
    model,
    label: model,
    local,
    contextTokens: null,
    inputUsdPerM: local ? 0 : 1,
    outputUsdPerM: local ? 0 : 4,
    modalities: [TAG.chat, TAG.text],
    tools: true,
    health: 'ok',
    seenAt: 1,
    ...extra,
  }) as ModelCatalogEntry;

const providers: Record<string, ProviderConfig> = {
  gemini: { apiKey: '', hasKey: true, type: 'gemini' as never, modelNames: [] },
  ollama: { apiKey: 'ollama', type: 'ollama' as never, baseUrl: 'http://localhost:11434/v1', modelNames: [] },
};

const catalog = [
  entry('gemini', 'gemini-3-flash', false),
  entry('ollama', 'qwen3:4b', true),
  entry('ollama', 'gemma4:12b', true),
  entry('ollama', 'nomic-embed-text', true, { modalities: [TAG.embedding, TAG.text] }),
];

const settings = (fallbackLocal: ModelSettingsRecord['fallbackLocal']): ModelSettingsRecord => ({
  ...DEFAULT_MODEL_SETTINGS,
  fallbackLocal,
});

describe('the fallback local model', () => {
  it('is on by default, with no model chosen: the best local chat model is used', () => {
    expect(DEFAULT_MODEL_SETTINGS.fallbackLocal).toEqual({ enabled: true, model: null });
    const pick = pickFallbackModel({ providers, catalog, health: {}, settings: DEFAULT_MODEL_SETTINGS });
    expect(pick?.local).toBe(true);
    expect(pick?.providerId).toBe('ollama');
    expect(pick).toMatchObject(
      pickRoleModel({ role: 'local', providers, catalog, health: {}, settings: DEFAULT_MODEL_SETTINGS })!,
    );
  });

  it('uses the chosen model while it is found, and picks again when it disappears', () => {
    const chosen = settings({ enabled: true, model: { providerId: 'ollama', model: 'gemma4:12b' } });
    expect(pickFallbackModel({ providers, catalog, health: {}, settings: chosen })).toMatchObject({
      providerId: 'ollama',
      model: 'gemma4:12b',
      source: 'user',
    });
    const without = catalog.filter(item => item.model !== 'gemma4:12b');
    expect(pickFallbackModel({ providers, catalog: without, health: {}, settings: chosen })?.model).toBe('qwen3:4b');
  });

  it('is null when turned off (unless asked to ignore that) and when no local chat model is found', () => {
    const off = settings({ enabled: false, model: null });
    expect(pickFallbackModel({ providers, catalog, health: {}, settings: off })).toBeNull();
    expect(
      pickFallbackModel({ providers, catalog, health: {}, settings: off }, { ignoreEnabled: true }),
    ).not.toBeNull();
    const cloudOnly = catalog.filter(item => !item.local);
    expect(
      pickFallbackModel({ providers, catalog: cloudOnly, health: {}, settings: DEFAULT_MODEL_SETTINGS }),
    ).toBeNull();
  });

  it('never offers an embedding model or a cloud one', () => {
    expect(localChatModels({ providers, catalog }).map(item => item.model)).toEqual(['qwen3:4b', 'gemma4:12b']);
  });

  it('fills in for settings saved before it existed', async () => {
    const data: Record<string, unknown> = { 'model-settings': { roles: {}, preferLocalLight: false } };
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: data[key] }),
          set: async (items: Record<string, unknown>) => Object.assign(data, items),
          onChanged: { addListener: () => undefined },
        },
      },
    });
    expect((await modelSettingsStore.getSettings()).fallbackLocal).toEqual({ enabled: true, model: null });
  });
});

describe('a model the caller chose by hand (the browser agent)', () => {
  const base = { providers, catalog, health: {}, settings: DEFAULT_MODEL_SETTINGS };
  const navigator = { providerId: 'gemini', model: 'gemini-3-flash' };

  it('wins over everyone’s mapping, and loses to the agent’s and the workspace’s', () => {
    const everyone = { ...DEFAULT_MODEL_SETTINGS, roles: { fast: { providerId: 'ollama', model: 'qwen3:4b' } } };
    expect(pickRoleModel({ ...base, role: 'fast', settings: everyone, explicit: navigator })).toMatchObject({
      ...navigator,
      source: 'setting',
    });
    const agent = { ...everyone, agentRoles: { a1: { fast: { providerId: 'ollama', model: 'gemma4:12b' } } } };
    expect(pickRoleModel({ ...base, role: 'fast', settings: agent, agentId: 'a1', explicit: navigator })).toMatchObject(
      {
        model: 'gemma4:12b',
        source: 'agent',
      },
    );
  });

  it('is used even when it is not among the active models, and stood in for when its provider is down', () => {
    const active = { ...providers, gemini: { ...providers.gemini, modelNames: ['gemini-other'] } };
    expect(
      pickRoleModel({ ...base, providers: active, role: 'fast', explicit: navigator, activeOnly: true }),
    ).toMatchObject(navigator);
    const down = pickRoleModel({ ...base, role: 'fast', explicit: navigator, down: new Set(['gemini']) });
    expect(down).toMatchObject({ providerId: 'ollama', standIn: true, local: true });
  });
});
