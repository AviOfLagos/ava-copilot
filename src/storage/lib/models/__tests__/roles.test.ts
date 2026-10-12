import { describe, expect, it, vi } from 'vitest';

// The settings modules read globalThis.chrome when they are imported
vi.hoisted(() => {
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: async () => ({}), set: async () => undefined, onChanged: { addListener: () => undefined } },
    },
  });
});

const { chatModelChoices, fitsRole, tagsFromName, TAG } = await import('../capabilities');
const { pickRoleModel, savedModelEntries } = await import('../roles');
const { DEFAULT_MODEL_SETTINGS } = await import('../settings');
import type { ModelCatalogEntry } from '../types';
import type { ProviderConfig } from '../../settings/llmProviders';
import type { ProviderHealth } from '../health';
import type { RoleInputs } from '../roles';

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

const health = (status: ProviderHealth['status']): ProviderHealth => ({
  status,
  checkedAt: 1,
  models: 1,
  error: null,
  errorKind: null,
  hint: null,
});

const providers: Record<string, ProviderConfig> = {
  gemini: { apiKey: '', hasKey: true, type: 'gemini' as never, modelNames: [] },
  openrouter: { apiKey: '', hasKey: true, type: 'openrouter' as never, modelNames: [] },
  ollama: { apiKey: 'ollama', type: 'ollama' as never, baseUrl: 'http://localhost:11434/v1', modelNames: [] },
  // Configured, but without the key it needs: never picked
  openai: { apiKey: '', type: 'openai' as never, modelNames: ['gpt-6-astra'] },
};

const catalog: ModelCatalogEntry[] = [
  entry('gemini', 'gemini-3.8-flash', {
    inputUsdPerM: 0.75,
    outputUsdPerM: 3.75,
    modalities: [TAG.chat, TAG.text, TAG.image, TAG.audio, TAG.search],
    tools: true,
  }),
  entry('gemini', 'gemini-3.1-pro-preview', {
    inputUsdPerM: 2,
    outputUsdPerM: 12,
    contextTokens: 1_000_000,
    modalities: [TAG.chat, TAG.text, TAG.image, TAG.audio, TAG.search, TAG.reasoning],
    tools: true,
  }),
  entry('gemini', 'gemini-embedding-2', { modalities: [TAG.embedding, TAG.text] }),
  entry('gemini', 'gemini-live-3-flash', { modalities: [TAG.live, TAG.audio, TAG.text] }),
  entry('gemini', 'gemini-3.5-flash-tts', { modalities: [TAG.speech, TAG.text] }),
  entry('openrouter', 'anthropic/claude-opus-5-5', { inputUsdPerM: 15, outputUsdPerM: 75, tools: true }),
  entry('ollama', 'qwen3.8:8b', { local: true, inputUsdPerM: 0, outputUsdPerM: 0, tools: true }),
  entry('ollama', 'nomic-embed-text', { local: true, inputUsdPerM: 0, outputUsdPerM: 0 }),
  entry('openai', 'gpt-6-astra'),
];

const inputs = (role: RoleInputs['role'], extra: Partial<RoleInputs> = {}): RoleInputs => ({
  role,
  providers,
  catalog,
  health: { gemini: health('ok'), openrouter: health('ok'), ollama: health('ok') },
  settings: DEFAULT_MODEL_SETTINGS,
  ...extra,
});

describe('tagsFromName', () => {
  it('tells chat models from embedding, speech, transcription, image and live ones', () => {
    expect(tagsFromName('nomic-embed-text')).toEqual([TAG.embedding, TAG.text]);
    expect(tagsFromName('text-embedding-3-small')).toContain(TAG.embedding);
    expect(tagsFromName('whisper-1')).toContain(TAG.transcription);
    expect(tagsFromName('gpt-4o-mini-tts')).toContain(TAG.speech);
    expect(tagsFromName('dall-e-3')).toContain(TAG.imageOutput);
    expect(tagsFromName('gpt-4o-realtime-preview')).toContain(TAG.live);
    expect(tagsFromName('nvidia/llama-3.1-nemoguard-8b-content-safety')).toContain(TAG.moderation);
    expect(tagsFromName('meta/llama-3.3-70b-instruct')).toEqual([TAG.chat, TAG.text]);
    expect(tagsFromName('llava:13b')).toContain(TAG.image);
    expect(tagsFromName('qwen2.5-vl-7b-instruct')).toContain(TAG.image);
    expect(tagsFromName('perplexity/sonar-pro')).toContain(TAG.search);
    expect(tagsFromName('deepseek-r1:14b')).toContain(TAG.reasoning);
  });
});

describe('fitsRole', () => {
  it('matches models to the work they can do', () => {
    const [flash, , embed, live, tts, , local] = catalog;
    expect(fitsRole(flash, 'vision')).toBe(true);
    expect(fitsRole(flash, 'transcribe')).toBe(true);
    expect(fitsRole(flash, 'search')).toBe(true);
    expect(fitsRole(embed, 'fast')).toBe(false);
    expect(fitsRole(embed, 'embed')).toBe(true);
    expect(fitsRole(live, 'realtime')).toBe(true);
    expect(fitsRole(tts, 'tts')).toBe(true);
    expect(fitsRole(local, 'local')).toBe(true);
    expect(fitsRole(flash, 'local')).toBe(false);
  });
});

describe('pickRoleModel', () => {
  it('picks by capability: a quick cheap model for fast work, a big one for smart work', () => {
    expect(pickRoleModel(inputs('fast'))).toMatchObject({
      providerId: 'gemini',
      model: 'gemini-3.8-flash',
      source: 'auto',
    });
    expect(pickRoleModel(inputs('smart'))?.model).toMatch(/opus|pro/);
    expect(pickRoleModel(inputs('embed'))).toMatchObject({ providerId: 'ollama', model: 'nomic-embed-text' });
    expect(pickRoleModel(inputs('realtime'))?.model).toBe('gemini-live-3-flash');
    expect(pickRoleModel(inputs('tts'))?.model).toBe('gemini-3.5-flash-tts');
    expect(pickRoleModel(inputs('local'))).toMatchObject({ providerId: 'ollama', model: 'qwen3.8:8b', local: true });
    expect(pickRoleModel(inputs('search'))?.providerId).toBe('gemini');
  });

  it('never picks a provider that has no key it needs', () => {
    const onlyOpenAI = inputs('fast', { catalog: catalog.filter(item => item.providerId === 'openai') });
    expect(pickRoleModel(onlyOpenAI)).toBeNull();
  });

  it("follows the user's mapping: an agent's over a workspace's over everyone's", () => {
    const settings = {
      ...DEFAULT_MODEL_SETTINGS,
      roles: { fast: { providerId: 'openrouter', model: 'anthropic/claude-opus-5-5' } },
      workspaceRoles: { nexprove: { fast: { providerId: 'ollama', model: 'qwen3.8:8b' } } },
      agentRoles: { scout: { fast: { providerId: 'gemini', model: 'gemini-3.1-pro-preview' } } },
    };
    expect(pickRoleModel(inputs('fast', { settings }))).toMatchObject({
      model: 'anthropic/claude-opus-5-5',
      source: 'user',
    });
    expect(pickRoleModel(inputs('fast', { settings, workspaceId: 'nexprove' }))).toMatchObject({
      model: 'qwen3.8:8b',
      source: 'workspace',
    });
    expect(pickRoleModel(inputs('fast', { settings, workspaceId: 'nexprove', agentId: 'scout' }))).toMatchObject({
      model: 'gemini-3.1-pro-preview',
      source: 'agent',
    });
  });

  it('uses the models chosen for the agents: the Planner for smart work, the Navigator for fast', () => {
    const agentModels = {
      planner: { provider: 'gemini', modelName: 'gemini-3.1-pro-preview' },
      navigator: { provider: 'openrouter', modelName: 'anthropic/claude-opus-5-5' },
    };
    expect(pickRoleModel(inputs('smart', { agentModels }))).toMatchObject({
      model: 'gemini-3.1-pro-preview',
      source: 'setting',
    });
    expect(pickRoleModel(inputs('fast', { agentModels }))).toMatchObject({
      model: 'anthropic/claude-opus-5-5',
      source: 'setting',
    });
  });

  it('stands in a healthy local model when the chosen cloud provider is down', () => {
    const settings = {
      ...DEFAULT_MODEL_SETTINGS,
      roles: { smart: { providerId: 'gemini', model: 'gemini-3.1-pro-preview' } },
    };
    const down = inputs('smart', {
      settings,
      health: { gemini: health('error'), openrouter: health('error'), ollama: health('ok') },
    });
    expect(pickRoleModel(down)).toMatchObject({ providerId: 'ollama', model: 'qwen3.8:8b', standIn: true });

    // A breaker that is open counts as down too
    const breaker = inputs('fast', { down: new Set(['gemini', 'openrouter']) });
    expect(pickRoleModel(breaker)).toMatchObject({ providerId: 'ollama', local: true });
  });

  it('keeps the pinned embedding model even while its provider is down', () => {
    const settings = { ...DEFAULT_MODEL_SETTINGS, pinnedEmbed: { providerId: 'gemini', model: 'gemini-embedding-2' } };
    const choice = pickRoleModel(inputs('embed', { settings, health: { gemini: health('error') } }));
    expect(choice).toMatchObject({ providerId: 'gemini', model: 'gemini-embedding-2', source: 'pinned' });
  });

  it('falls back to the model names saved with a provider before the registry has listed it', () => {
    const fresh = inputs('fast', {
      catalog: [],
      providers: {
        gemini: {
          apiKey: '',
          hasKey: true,
          type: 'gemini' as never,
          modelNames: ['gemini-3.1-pro-preview', 'gemini-3.8-flash'],
        },
      },
      health: {},
    });
    expect(pickRoleModel(fresh)).toMatchObject({ model: 'gemini-3.8-flash', source: 'fallback' });
    expect(savedModelEntries(fresh.providers, [])[0].modalities).toContain(TAG.search);
  });
});

describe('chatModelChoices', () => {
  it('offers the catalog once it lists the provider, saved names first, and the saved names before that', () => {
    expect(chatModelChoices('gemini', ['gemini-3.8-flash', 'gone-model'], catalog)).toEqual([
      'gemini-3.8-flash',
      'gemini-3.1-pro-preview',
    ]);
    expect(chatModelChoices('deepseek', ['deepseek-flash'], catalog)).toEqual(['deepseek-flash']);
  });
});
