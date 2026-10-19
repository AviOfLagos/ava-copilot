import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../../agent/executor', () => ({ Executor: class {} }));
vi.mock('../../browser/context', () => ({ default: class {} }));

const { agentModelStore, db, modelHealthStore, modelSettingsStore } = await import('@extension/storage');
const { resolveModels } = await import('../factory');
const { resetBreakers } = await import('../../models/breakers');

const scope = { sessionId: 'resolve-test', notify: () => {}, workspaceId: null, agentId: null };

const model = (providerId: string, name: string, local: boolean, modalities = ['chat', 'text']) => ({
  id: `${providerId}:${name}`,
  providerId,
  model: name,
  label: name,
  local,
  contextTokens: null,
  inputUsdPerM: local ? 0 : 1,
  outputUsdPerM: local ? 0 : 4,
  modalities,
  tools: true,
  health: 'ok' as const,
  seenAt: 1,
});

beforeEach(async () => {
  for (const key of Object.keys(store)) delete store[key];
  resetBreakers();
  await db.modelCatalog.clear();
  store['llm-api-keys'] = {
    providers: {
      gemini: { name: 'Gemini', type: 'gemini', apiKey: 'g-key', modelNames: [], createdAt: 1 },
      ollama: {
        name: 'Ollama',
        type: 'ollama',
        apiKey: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelNames: ['qwen3:4b'],
        createdAt: 2,
      },
    },
  };
  await db.modelCatalog.bulkPut([
    model('gemini', 'gemini-3-flash', false),
    model('gemini', 'gemini-3.1-pro', false, ['chat', 'text', 'reasoning']),
    model('ollama', 'qwen3:4b', true),
  ]);
});

// Through the store, which keeps what it last wrote
const setAgents = (agents: Record<string, { provider: string; modelName: string; reasoningEffort?: string }>) =>
  agentModelStore.set({ agents } as never);

describe('the browser agent picks its models by role', () => {
  it('keeps the Navigator and Planner the user chose, and gives a cloud model the local fallback', async () => {
    await setAgents({
      navigator: { provider: 'gemini', modelName: 'gemini-3-flash' },
      planner: { provider: 'gemini', modelName: 'gemini-3.1-pro', reasoningEffort: 'high' },
    });
    // Everyone's fast mapping loses to the agent's own choice
    await modelSettingsStore.setRole('fast', { providerId: 'ollama', model: 'qwen3:4b' });
    const { navigator, planner } = await resolveModels(null, scope);
    expect([navigator.provider, navigator.modelName]).toEqual(['gemini', 'gemini-3-flash']);
    expect([planner.provider, planner.modelName]).toEqual(['gemini', 'gemini-3.1-pro']);
    expect(navigator.fallback).toBeDefined();
    expect(planner.fallback).toBeDefined();
  });

  it('shares one model when the Planner is not set', async () => {
    await setAgents({ navigator: { provider: 'gemini', modelName: 'gemini-3-flash' } });
    const { navigator, planner } = await resolveModels(null, scope);
    expect(planner).toBe(navigator);
  });

  it('uses an agent’s own mapping in that agent’s chats', async () => {
    await setAgents({ navigator: { provider: 'gemini', modelName: 'gemini-3-flash' } });
    await modelSettingsStore.setRole('fast', { providerId: 'ollama', model: 'qwen3:4b' }, { agentId: 'agent-1' });
    const { navigator } = await resolveModels(null, { ...scope, agentId: 'agent-1' });
    expect([navigator.provider, navigator.modelName]).toEqual(['ollama', 'qwen3:4b']);
    // A local model has nothing to fall back to
    expect(navigator.fallback).toBeUndefined();
  });

  it('stands in a local model when the chosen provider is down', async () => {
    await setAgents({ navigator: { provider: 'gemini', modelName: 'gemini-3-flash' } });
    await modelHealthStore.setProviders({
      gemini: { status: 'error', checkedAt: 1, models: 0, error: 'down', errorKind: 'unavailable', hint: null },
    });
    const { navigator } = await resolveModels(null, scope);
    expect([navigator.provider, navigator.modelName]).toEqual(['ollama', 'qwen3:4b']);
  });

  it('picks the best model when no agent model is set', async () => {
    await setAgents({});
    const { navigator, planner } = await resolveModels(null, scope);
    expect(navigator.modelName).toBeTruthy();
    expect(planner.modelName).toBeTruthy();
  });

  it('runs a thread’s own model for both agents', async () => {
    await setAgents({ navigator: { provider: 'gemini', modelName: 'gemini-3-flash' } });
    const { navigator, planner } = await resolveModels({ provider: 'ollama', modelName: 'qwen3:4b' }, scope);
    expect(planner).toBe(navigator);
    expect(navigator.modelName).toBe('qwen3:4b');
  });

  it('asks for a provider when none is set up', async () => {
    store['llm-api-keys'] = { providers: {} };
    await expect(resolveModels(null, scope)).rejects.toThrow('bg_setup_noApiKeys');
  });
});
