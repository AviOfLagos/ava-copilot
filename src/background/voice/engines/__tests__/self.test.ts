import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveRole = vi.hoisted(() => vi.fn());
const navigator = vi.hoisted(() => ({ value: null as { provider: string; modelName: string } | null }));

vi.mock('../../../models/roles', () => ({ resolveRole }));
vi.mock('@extension/storage', () => ({
  AgentNameEnum: { Navigator: 'navigator' },
  agentModelStore: { getAgentModel: async () => navigator.value },
  llmProviderStore: { getProviderSummaries: async () => ({ gemini: { name: 'Gemini' } }) },
  voiceLanguageName: (tag: string) => ({ 'en-US': 'English (US)', 'pt-BR': 'Portuguese (Brazil)' })[tag] ?? tag,
}));

const { aboutYouSection, economyModelOf } = await import('../self');
const { voiceSessionInstructions } = await import('../../prompt');

describe('aboutYouSection', () => {
  it('says the model, engine, recogniser and languages of an economy conversation', () => {
    const text = aboutYouSection({
      engine: 'economy',
      model: { provider: 'Gemini', model: 'chat-model-x' },
      recogniser: { engine: 'whisper', model: 'whisper-base', language: 'pt' },
      language: 'pt-BR',
    });
    expect(text).toMatch(/^About you right now/);
    expect(text).toContain('Model answering: chat-model-x (provider: Gemini)');
    expect(text).toContain('Voice engine: economy');
    expect(text).toContain('Speech recogniser: Whisper, on this computer');
    expect(text).toContain('Hearing language: pt');
    expect(text).toContain("The user's chosen language: Portuguese (Brazil) (pt-BR)");
    expect(text).toMatch(/check_audio/);
    expect(text).toMatch(/check_model/);
  });

  it('says Live hears in the user language, and an English-only recogniser hears English only', () => {
    const live = aboutYouSection({
      engine: 'live',
      model: { provider: 'Gemini', model: 'live-model-y' },
      recogniser: null,
      language: 'en-US',
    });
    expect(live).toContain('Model answering: live-model-y');
    expect(live).toContain('Voice engine: Gemini Live');
    expect(live).toContain('Hearing language: English (US) (en-US)');
    const moonshine = aboutYouSection({
      engine: 'economy',
      model: null,
      recogniser: { engine: 'moonshine', model: 'moonshine-tiny' },
      language: 'pt-BR',
    });
    expect(moonshine).toContain('Model answering: not set up');
    expect(moonshine).toContain('Hearing language: English only');
  });

  it('goes into the voice instructions, right after the rules', () => {
    const self = aboutYouSection({ engine: 'live', model: null, recogniser: null, language: 'en-US' });
    const text = voiceSessionInstructions('Ava', '', null, '', '', 'What you can do: …', self);
    expect(text.indexOf('About you right now')).toBeGreaterThan(0);
    expect(text.indexOf('About you right now')).toBeLessThan(text.indexOf('What you can do'));
  });
});

describe('economyModelOf', () => {
  beforeEach(() => {
    resolveRole.mockReset();
    navigator.value = null;
  });

  it("names the chats' model for 'chat', resolved like a chat resolves its Navigator", async () => {
    navigator.value = { provider: 'gemini', modelName: 'nav-model' };
    resolveRole.mockResolvedValue({ providerId: 'gemini', model: 'nav-model', source: 'setting', local: false });
    expect(await economyModelOf('chat')).toEqual({ provider: 'Gemini', model: 'nav-model' });
    expect(resolveRole).toHaveBeenCalledWith('fast', { explicit: { providerId: 'gemini', model: 'nav-model' } });
  });

  it("asks the role itself for 'fast' and 'local', and says null when nothing can answer", async () => {
    resolveRole.mockResolvedValue({ providerId: 'ollama', model: 'small', source: 'auto', local: true });
    expect(await economyModelOf('local')).toEqual({ provider: 'ollama', model: 'small' });
    expect(resolveRole).toHaveBeenCalledWith('local');
    resolveRole.mockRejectedValue(new Error('none'));
    expect(await economyModelOf('fast')).toBeNull();
  });
});
