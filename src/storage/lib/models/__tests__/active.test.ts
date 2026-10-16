import { describe, expect, it, vi } from 'vitest';

// The settings modules read globalThis.chrome when they are imported
vi.hoisted(() => {
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: async () => ({}), set: async () => undefined, onChanged: { addListener: () => undefined } },
    },
  });
});

const { activeModelIds, defaultActiveModels, withModelActive } = await import('../active');
const { tagsFromName, TAG } = await import('../capabilities');
const { pickRoleModel } = await import('../roles');
const { DEFAULT_MODEL_SETTINGS } = await import('../settings');
const { decideLightRoute } = await import('../routing');
import type { ModelCatalogEntry } from '../types';
import type { ProviderConfig } from '../../settings/llmProviders';

const entry = (providerId: string, model: string, extra: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => ({
  id: `${providerId}:${model}`,
  providerId,
  model,
  label: model,
  local: providerId === 'ollama',
  contextTokens: null,
  inputUsdPerM: null,
  outputUsdPerM: null,
  modalities: tagsFromName(model),
  tools: true,
  health: 'ok',
  seenAt: 1,
  ...extra,
});

const catalog: ModelCatalogEntry[] = [
  entry('openrouter', 'anthropic/claude-opus-5-5', { inputUsdPerM: 15, outputUsdPerM: 75 }),
  entry('openrouter', 'openai/gpt-5-mini', { inputUsdPerM: 0.25, outputUsdPerM: 2 }),
  entry('openrouter', 'google/gemini-3-flash', {
    inputUsdPerM: 0.3,
    outputUsdPerM: 2.5,
    modalities: [TAG.chat, TAG.text, TAG.image, TAG.audio],
  }),
  entry('openrouter', 'deepseek/deepseek-v4', { inputUsdPerM: 0.3, outputUsdPerM: 1.2 }),
  entry('ollama', 'qwen3:8b', { inputUsdPerM: 0, outputUsdPerM: 0 }),
  entry('ollama', 'nomic-embed-text:latest', { modalities: [TAG.embedding, TAG.text] }),
];

const providers = (openrouter: string[], ollama: string[] = []): Record<string, ProviderConfig> => ({
  openrouter: { apiKey: '', hasKey: true, type: 'openrouter' as never, modelNames: openrouter },
  ollama: { apiKey: 'ollama', type: 'ollama' as never, baseUrl: 'http://localhost:11434/v1', modelNames: ollama },
});

describe('active models', () => {
  it('are the names saved with a provider; a provider with none saved offers everything it lists', () => {
    const active = activeModelIds(providers(['openai/gpt-5-mini']), catalog);
    expect(active.has('openrouter:openai/gpt-5-mini')).toBe(true);
    expect(active.has('openrouter:anthropic/claude-opus-5-5')).toBe(false);
    expect(active.has('ollama:qwen3:8b')).toBe(true);
    expect(active.has('ollama:nomic-embed-text:latest')).toBe(true);
  });

  it('turn on and off, and the last one of a provider stays on', () => {
    expect(withModelActive(['a'], ['a', 'b'], 'b', true)).toEqual(['a', 'b']);
    expect(withModelActive(['a', 'b'], ['a', 'b'], 'a', false)).toEqual(['b']);
    // None saved means all listed: turning one off keeps the rest
    expect(withModelActive([], ['a', 'b', 'c'], 'b', false)).toEqual(['a', 'c']);
    // Already on (all listed): nothing to write but the same list
    expect(withModelActive([], ['a', 'b'], 'a', true)).toEqual([]);
    expect(withModelActive(['a'], ['a', 'b'], 'a', false)).toBeNull();
  });

  it('start as every local model, or a cloud provider’s best per kind of work', () => {
    const local = catalog.filter(item => item.local);
    expect(defaultActiveModels(local, true)).toEqual(['nomic-embed-text:latest', 'qwen3:8b']);
    const cloud = defaultActiveModels(
      catalog.filter(item => !item.local),
      false,
    );
    expect(cloud.length).toBeGreaterThanOrEqual(2);
    expect(cloud.length).toBeLessThanOrEqual(6);
    expect(cloud).toContain('anthropic/claude-opus-5-5');
    expect(cloud).toContain('openai/gpt-5-mini');
  });
});

describe('roles pick from active models only', () => {
  const pick = (role: 'smart' | 'fast' | 'vision' | 'embed', configs: Record<string, ProviderConfig>, extra = {}) =>
    pickRoleModel({
      role,
      providers: configs,
      catalog,
      health: {},
      settings: DEFAULT_MODEL_SETTINGS,
      activeOnly: true,
      ...extra,
    });

  it('never chooses a model that is off', () => {
    const configs = providers(['openai/gpt-5-mini'], ['qwen3:8b']);
    expect(pick('smart', configs)).toMatchObject({ providerId: 'openrouter', model: 'openai/gpt-5-mini' });
    // No active model can see: no vision, rather than an inactive one
    expect(pick('vision', configs)?.model).not.toBe('anthropic/claude-opus-5-5');
    expect(pick('embed', configs)).toBeNull();
  });

  it('without the filter keeps the old behaviour (every listed model)', () => {
    const choice = pickRoleModel({
      role: 'smart',
      providers: providers(['openai/gpt-5-mini']),
      catalog,
      health: {},
      settings: DEFAULT_MODEL_SETTINGS,
    });
    expect(choice?.model).toBe('anthropic/claude-opus-5-5');
  });

  it('skips a mapping or an agent model that was turned off, but keeps the pinned embedding model', () => {
    const configs = providers(['openai/gpt-5-mini'], ['qwen3:8b']);
    const settings = {
      ...DEFAULT_MODEL_SETTINGS,
      roles: { smart: { providerId: 'openrouter', model: 'anthropic/claude-opus-5-5' } },
      pinnedEmbed: { providerId: 'ollama', model: 'nomic-embed-text:latest' },
    };
    expect(pick('smart', configs, { settings })?.model).toBe('openai/gpt-5-mini');
    expect(
      pick('fast', configs, {
        settings,
        agentModels: { navigator: { provider: 'openrouter', modelName: 'deepseek/deepseek-v4' } },
      })?.model,
    ).toBe('openai/gpt-5-mini');
    expect(pick('embed', configs, { settings })).toMatchObject({ model: 'nomic-embed-text:latest', source: 'pinned' });
  });
});

describe('light work routing', () => {
  const local = { providerId: 'ollama', model: 'qwen3:8b' };

  it('goes to a running local model when the user prefers local', () => {
    expect(decideLightRoute({ preferLocal: true, cloudAllowed: false, noticeAt: null, runningLocal: local })).toEqual({
      route: 'local',
      target: local,
    });
  });

  it('with no local model running, tells the user once, then uses the cloud', () => {
    expect(decideLightRoute({ preferLocal: true, cloudAllowed: false, noticeAt: null, runningLocal: null })).toEqual({
      route: 'cloud',
      notice: true,
      reason: 'noLocal',
    });
    expect(
      decideLightRoute({ preferLocal: true, cloudAllowed: false, noticeAt: 123, runningLocal: null }),
    ).toMatchObject({ route: 'cloud', notice: false });
  });

  it('uses the cloud without a notice when the user allowed it, or turned local off', () => {
    expect(decideLightRoute({ preferLocal: true, cloudAllowed: true, noticeAt: null, runningLocal: null })).toEqual({
      route: 'cloud',
      notice: false,
      reason: 'allowed',
    });
    expect(
      decideLightRoute({ preferLocal: false, cloudAllowed: false, noticeAt: null, runningLocal: local }),
    ).toMatchObject({ route: 'cloud', notice: false, reason: 'preferCloud' });
  });
});
