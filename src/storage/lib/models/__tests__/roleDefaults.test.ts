import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys?: string | string[]) => {
          const list = keys === undefined ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter(k => k in data).map(k => [k, structuredClone(data[k])]));
        },
        set: async (items: Record<string, unknown>) => void Object.assign(data, structuredClone(items)),
        onChanged: { addListener: () => undefined },
      },
    },
  });
  return data;
});

const { pickRoleDefaults, applyRoleDefaults } = await import('../roleDefaults');
const { tagsFromName } = await import('../capabilities');
const { modelSettingsStore } = await import('../settings');
const { agentModelStore } = await import('../../settings/agentModels');
const { AgentNameEnum, ProviderTypeEnum } = await import('../../settings/types');
import type { ModelCatalogEntry } from '../types';

const entry = (providerId: string, model: string, extra: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => ({
  id: `${providerId}:${model}`,
  providerId,
  model,
  label: model,
  local: false,
  contextTokens: null,
  inputUsdPerM: null,
  outputUsdPerM: null,
  modalities: tagsFromName(model),
  tools: null,
  health: 'ok',
  seenAt: 1,
  ...extra,
});

const providers = (list: Record<string, Record<string, unknown>>) => {
  store['llm-api-keys'] = { providers: list };
};

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
});

describe('pickRoleDefaults', () => {
  it('gives a cloud provider its strongest model for smart work and a quick one for fast work', () => {
    const entries = ['gpt-6-astra', 'gpt-6-luna-mini', 'text-embedding-3-small'].map(name => entry('openai', name));
    expect(pickRoleDefaults(entries, { type: ProviderTypeEnum.OpenAI, local: false })).toEqual({
      smart: 'gpt-6-astra',
      fast: 'gpt-6-luna-mini',
    });
  });

  it('keeps Gemini’s own pair when it is offered', () => {
    const entries = ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.5-flash-lite'].map(name =>
      entry('gemini', name),
    );
    expect(pickRoleDefaults(entries, { type: ProviderTypeEnum.Gemini, local: false })).toEqual({
      smart: 'gemini-3.1-pro-preview',
      fast: 'gemini-3.8-flash',
    });
  });

  it('gives a local server one chat model for both, never an embedding model', () => {
    const entries = [
      entry('ollama', 'nomic-embed-text', { local: true }),
      entry('ollama', 'qwen3:4b', { local: true, tools: true }),
    ];
    expect(pickRoleDefaults(entries, { type: ProviderTypeEnum.Ollama, local: true })).toEqual({
      smart: 'qwen3:4b',
      fast: 'qwen3:4b',
    });
  });

  it('has nothing to give a provider without chat models', () => {
    const entries = [entry('ollama', 'nomic-embed-text', { local: true })];
    expect(pickRoleDefaults(entries, { type: ProviderTypeEnum.Ollama, local: true })).toEqual({
      smart: null,
      fast: null,
    });
  });
});

describe('applyRoleDefaults', () => {
  const ollama = [entry('ollama', 'qwen3:4b', { local: true })];

  it('fills empty agents and roles', async () => {
    providers({ ollama: { type: 'ollama', apiKey: 'ollama', baseUrl: 'http://localhost:11434/v1' } });
    const applied = await applyRoleDefaults('ollama', ollama, { type: ProviderTypeEnum.Ollama, local: true });
    expect(Object.keys(applied.agents).sort()).toEqual(['navigator', 'planner']);
    expect(await agentModelStore.getAgentModel(AgentNameEnum.Navigator)).toEqual({
      provider: 'ollama',
      modelName: 'qwen3:4b',
    });
    expect((await modelSettingsStore.getSettings()).roles).toEqual({
      smart: { providerId: 'ollama', model: 'qwen3:4b' },
      fast: { providerId: 'ollama', model: 'qwen3:4b' },
    });
  });

  it('never changes a working choice the user made, nor its role mapping', async () => {
    providers({
      openai: { type: 'openai', apiKey: 'sk-test', modelNames: ['gpt-6-astra'] },
      ollama: { type: 'ollama', apiKey: 'ollama' },
    });
    await agentModelStore.setAgentModel(AgentNameEnum.Navigator, { provider: 'openai', modelName: 'gpt-6-astra' });
    await agentModelStore.setAgentModel(AgentNameEnum.Planner, { provider: 'openai', modelName: 'gpt-6-astra' });
    const applied = await applyRoleDefaults('ollama', ollama, { type: ProviderTypeEnum.Ollama, local: true });
    expect(applied.agents).toEqual({});
    expect(await agentModelStore.getAgentModel(AgentNameEnum.Navigator)).toMatchObject({ provider: 'openai' });
    expect((await modelSettingsStore.getSettings()).roles).toEqual({});
  });

  it('replaces a choice whose provider is gone or has lost its key', async () => {
    providers({
      anthropic: { type: 'anthropic', apiKey: '' },
      ollama: { type: 'ollama', apiKey: 'ollama' },
    });
    await agentModelStore.setAgentModel(AgentNameEnum.Navigator, { provider: 'removed', modelName: 'x' });
    await agentModelStore.setAgentModel(AgentNameEnum.Planner, { provider: 'anthropic', modelName: 'claude' });
    await modelSettingsStore.setRole('smart', { providerId: 'removed', model: 'x' });
    await applyRoleDefaults('ollama', ollama, { type: ProviderTypeEnum.Ollama, local: true });
    expect(await agentModelStore.getAgentModel(AgentNameEnum.Navigator)).toMatchObject({ provider: 'ollama' });
    expect(await agentModelStore.getAgentModel(AgentNameEnum.Planner)).toMatchObject({ provider: 'ollama' });
    expect((await modelSettingsStore.getSettings()).roles.smart).toEqual({ providerId: 'ollama', model: 'qwen3:4b' });
  });
});
