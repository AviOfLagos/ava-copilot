import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Storage from '@extension/storage';
import type { Personality } from '@extension/storage';

/**
 * The voice conversation and personalities' voices: the Live setup speaks in the personality's voice, a switch
 * restarts the session in the new one (or changes the economy voice), and an agent's answer is said in the agent's
 * own voice with its name first.
 */

vi.stubGlobal('chrome', {
  runtime: { getPlatformInfo: async () => ({}), sendMessage: async () => ({}) },
  i18n: { getMessage: (key: string) => key },
  storage: {
    local: { get: async () => ({}), set: async () => {}, onChanged: { addListener: () => {} } },
    session: { get: async () => ({}), set: async () => {}, onChanged: { addListener: () => {} } },
    sync: { get: async () => ({}), set: async () => {}, onChanged: { addListener: () => {} } },
    onChanged: { addListener: () => {} },
  },
});

const sent: Record<string, unknown>[] = [];
vi.mock('../../offscreen', () => ({
  ensureOffscreen: async () => {},
  closeOffscreenIfIdle: async () => {},
  toOffscreen: async (message: Record<string, unknown>) => {
    sent.push(message);
    return { ok: true };
  },
}));

// The user's vocabulary is tested on its own (../vocabulary); here only that the conversation applies it
vi.mock('../vocabulary', () => ({ correctedText: async (text: string) => text.replace('Illum', 'Ellum') }));
const stored: [string, string, string][] = [];

const state = {
  economy: null as null | { mode: 'economy'; economy: { stt: { engine: 'moonshine' }; tts: Record<string, unknown> } },
  personality: null as Personality | null,
  threads: [] as Record<string, unknown>[],
  messages: {} as Record<string, { actor: string; content: string }[]>,
  agents: {} as Record<string, Record<string, unknown>>,
};

vi.mock('../engines/options', () => ({ economyVoiceOptions: async () => state.economy }));
vi.mock('../engines/models', () => ({
  installedVoiceModels: async () => ({ kitten: true }),
  forgetInstalledVoiceModels: () => {},
}));
vi.mock('../../threads/factory', () => ({ resolveModels: vi.fn() }));
vi.mock('../../usage/budget', () => ({ isOverDailyBudget: async () => false }));
vi.mock('../../identity/context', () => ({ loadIdentityContext: async () => ({}) }));
vi.mock('../../identity/prompt', () => ({ voiceCoreSection: () => '' }));
vi.mock('../../models/liveToken', () => ({ usesLiveTokens: () => false }));
vi.mock('../../jobs/runner', () => ({ jobs: { schedule: async () => {} } }));

vi.mock('@extension/storage', async importOriginal => {
  const actual = (await importOriginal()) as typeof Storage;
  const list = async () => state.threads;
  return {
    ...actual,
    db: {
      threads: { orderBy: () => ({ reverse: () => ({ toArray: list }) }), toArray: list },
      agents: { get: async (id: string) => state.agents[id] },
    },
    threadStore: {
      create: async () => ({ id: 'voice-1', tags: ['voice'] }),
      messages: async (id: string) => state.messages[id] ?? [],
      addMessage: async (thread: string, actor: string, content: string) => {
        stored.push([thread, actor, content]);
      },
      remove: async () => {},
      get: async () => undefined,
    },
    personalityStore: {
      resolve: async () => state.personality ?? actual.BUILTIN_PERSONALITIES[0],
      getState: async () => actual.EMPTY_PERSONALITIES,
      subscribe: () => () => {},
    },
    llmProviderStore: { getAllProviders: async () => ({ gemini: { type: 'gemini', apiKey: 'key' } }) },
    meetingSettingsStore: {
      getSettings: async () => ({ liveModel: 'gemini-live-test', liveEndpoint: 'wss://example.test/live' }),
    },
    generalSettingsStore: { getSettings: async () => ({ stylePrompt: '', assistantName: 'Ava' }) },
    voiceIdentityStore: { getSettings: async () => ({ liveVoice: 'Aoede', language: 'en-US' }) },
    voiceEngineSettingsStore: { getSettings: async () => ({ kittenVoice: 'Bella', kokoroVoice: 'af_heart' }) },
    ttsSettingsStore: { getSettings: async () => ({ engine: 'kitten', engineChosen: true, voice: '', rate: 1 }) },
    meetingStore: { list: async () => [], active: async () => [] },
  };
});

const { BUILTIN_PERSONALITIES } = await import('@extension/storage');
const { VoiceManager } = await import('../manager');

const byId = (id: string) => BUILTIN_PERSONALITIES.find(item => item.id === id)!;
const manager = () => new VoiceManager({} as never, {} as never);
const startOf = () => sent.find(message => message.type === 'voice_start') as { options: Record<string, unknown> };
const voiceNameOf = (config: unknown) =>
  (config as { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } }).voiceConfig.prebuiltVoiceConfig.voiceName;

beforeEach(() => {
  sent.length = 0;
  state.economy = null;
  state.personality = null;
  state.threads = [];
  state.messages = {};
  state.agents = {};
});

describe('what the user said in the voice conversation', () => {
  it('is kept with the vocabulary applied, and what Ava said is kept as it was', async () => {
    stored.length = 0;
    const voice = manager();
    await voice.start();
    await voice.onTurn('Open the Illum AI page', 'Opening Illum now');
    expect(stored).toEqual([
      ['voice-1', 'user', 'Open the Ellum AI page'],
      ['voice-1', 'planner', 'Opening Illum now'],
    ]);
    await voice.stop();
  });
});

describe('the Live voice of a personality', () => {
  it("is Ava's Settings voice for the default personality", async () => {
    const voice = manager();
    await voice.start();
    expect(voiceNameOf(startOf().options.speechConfig)).toBe('Aoede');
    await voice.stop();
  });

  it("is the personality's own Live voice when it has one", async () => {
    state.personality = byId('engineer');
    const voice = manager();
    await voice.start();
    expect(voiceNameOf(startOf().options.speechConfig)).toBe('Puck');
    await voice.stop();
  });

  it('restarts the Live session in the new voice on a switch, with the new instructions', async () => {
    const voice = manager();
    await voice.start();
    state.messages['voice-1'] = [{ actor: 'user', content: 'Switch to the accountant' }];
    const restarts = await voice.applyPersonality(byId('accountant'), 'greet');
    expect(restarts).toBe(true);
    const change = sent.find(message => message.type === 'voice_reconfigure')!;
    expect(voiceNameOf(change.speechConfig)).toBe('Charon');
    expect(change.notice).toBe('greet');
    expect(String(change.instructions)).toContain('Accountant');
    expect(String(change.instructions)).toContain('Switch to the accountant');
    // The same switch again (the voice tool, then the settings change) changes nothing more
    expect(await voice.applyPersonality(byId('accountant'), 'greet')).toBe(true);
    expect(sent.filter(message => message.type === 'voice_reconfigure')).toHaveLength(1);
    await voice.stop();
  });

  it('does not restart when the voice stays the same', async () => {
    const voice = manager();
    await voice.start();
    const plain = { ...byId('accountant'), id: 'custom-x', voices: {} };
    expect(await voice.applyPersonality(plain, 'greet')).toBe(false);
    const change = sent.find(message => message.type === 'voice_reconfigure')!;
    expect(voiceNameOf(change.speechConfig)).toBe('Aoede');
    expect(change.notice).toBe('');
    await voice.stop();
  });

  it('changes the economy voice for the next answer, without a restart', async () => {
    state.economy = {
      mode: 'economy',
      economy: { stt: { engine: 'moonshine' }, tts: { engine: 'kitten', voice: 'Bella', rate: 1 } },
    };
    const voice = manager();
    await voice.start();
    state.economy = {
      mode: 'economy',
      economy: { stt: { engine: 'moonshine' }, tts: { engine: 'kitten', voice: 'Leo', rate: 1.1 } },
    };
    expect(await voice.applyPersonality(byId('engineer'), 'greet')).toBe(false);
    const change = sent.find(message => message.type === 'voice_reconfigure')!;
    expect(change.economyTts).toEqual({ engine: 'kitten', voice: 'Leo', rate: 1.1 });
    expect(change.speechConfig).toBeUndefined();
    await voice.stop();
  });
});

describe("an agent's line", () => {
  const research = { id: 'a1', name: 'Research', personalityId: 'engineer', voices: { kitten: 'Jasper' } };

  it('is said in its own voice on the device during a Live conversation, its name first', async () => {
    state.agents.a1 = research;
    const voice = manager();
    await voice.start();
    const { agentSpeaker } = await import('../../personalities/voices');
    const speaker = (await agentSpeaker('a1'))!;
    expect(await voice.speakAs(speaker, 'Three new papers.')).toBe(true);
    const line = sent.find(message => message.type === 'voice_speak_as')!;
    expect(line.text).toBe('Research: Three new papers.');
    // The read-aloud engine (Kitten, installed) with the agent's own Kitten voice, at its personality's pace
    expect(line.tts).toEqual({ engine: 'kitten', voice: 'Jasper', rate: 1.1 });
    await voice.stop();
  });

  it('keeps the economy engine and takes the agent voice for it', async () => {
    state.agents.a1 = { ...research, voices: {} };
    state.economy = {
      mode: 'economy',
      economy: { stt: { engine: 'moonshine' }, tts: { engine: 'system', voice: 'Samantha', rate: 1 } },
    };
    const voice = manager();
    await voice.start();
    await voice.announce('Done.', {
      name: 'Research',
      voices: { system: 'Daniel', kitten: 'Leo' },
    });
    const line = sent.find(message => message.type === 'voice_speak_as')!;
    expect(line.text).toBe('Research: Done.');
    expect(line.tts).toEqual({ engine: 'system', voice: 'Daniel', rate: 1 });
    expect(sent.some(message => message.type === 'voice_say')).toBe(false);
    await voice.stop();
  });

  it("is a hand-off's answer heard from the thread watch", async () => {
    state.agents.a1 = research;
    vi.useFakeTimers();
    try {
      const voice = manager();
      state.threads = [
        { id: 'run-1', status: 'running', agentId: 'a1', origin: 'agent', title: 'Research · now', tags: [] },
      ];
      await voice.start();
      state.threads = [
        { id: 'run-1', status: 'idle', agentId: 'a1', origin: 'agent', title: 'Research · now', tags: [] },
      ];
      state.messages['run-1'] = [{ actor: 'planner', content: 'Found  two\nsources.' }];
      await vi.advanceTimersByTimeAsync(2100);
      const line = sent.find(message => message.type === 'voice_speak_as');
      expect(line?.text).toBe('Research: Found two sources.');
      expect(sent.some(message => message.type === 'voice_say')).toBe(false);
      await voice.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
