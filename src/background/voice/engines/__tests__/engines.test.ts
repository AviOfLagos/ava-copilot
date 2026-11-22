import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE_ENGINE_SETTINGS } from '@extension/storage';
import en from '../../../../../public/_locales/en/messages.json';

// The English sentences, so what the user reads is what is checked
vi.mock('@extension/i18n', () => ({
  t: (key: string) => (en as Record<string, { message: string }>)[key]?.message ?? key,
}));
import { isVoiceActivity, shouldEndIdle } from '../idle';
import { parseVoiceManifest } from '../models';
import { chooseEconomyEngines, modelsNeeded, SETUP_COMMAND } from '../options';
import { toJsonSchema, voiceToolSet } from '../tools';

const settings = (changes: Partial<typeof DEFAULT_VOICE_ENGINE_SETTINGS> = {}) => ({
  ...DEFAULT_VOICE_ENGINE_SETTINGS,
  mode: 'economy' as const,
  ...changes,
});
const tts = { engine: 'system', voice: 'Samantha', rate: 1.1 };

describe('chooseEconomyEngines on a computer where the local voice is too slow', () => {
  const installed = { 'moonshine-tiny': { bytes: 1 }, kitten: { bytes: 1 } };
  const slow = { tts: { kitten: { speed: 0.73, at: Date.now(), source: 'benchmark' as const } } };

  it("uses the computer's own voice, and says which local voice it set aside", () => {
    const choice = chooseEconomyEngines(
      settings(),
      { ...tts, engine: 'kitten', voice: '' },
      installed,
      undefined,
      slow,
    );
    expect(choice).toMatchObject({
      engines: { tts: { engine: 'system', voice: '' } },
      slow: { engine: 'kitten', speed: 0.73 },
    });
  });

  it('keeps the local voice when it keeps up, or when nothing was measured', () => {
    const fast = { tts: { kitten: { speed: 2.4, at: Date.now(), source: 'benchmark' as const } } };
    for (const health of [fast, { tts: {} }, undefined]) {
      const choice = chooseEconomyEngines(settings(), { ...tts, engine: 'kitten' }, installed, undefined, health);
      expect(choice).toMatchObject({ engines: { tts: { engine: 'kitten', voice: 'Bella' } } });
      expect(choice).not.toHaveProperty('slow');
    }
  });

  it('does not carry the system voice name over to a voice that was chosen as local', () => {
    const choice = chooseEconomyEngines(
      settings(),
      { ...tts, engine: 'kitten', voice: 'Leo' },
      installed,
      undefined,
      slow,
    );
    expect(choice).toMatchObject({ engines: { tts: { engine: 'system', voice: '' } } });
  });

  it('keeps the system voice name when the system voices were chosen', () => {
    const choice = chooseEconomyEngines(settings(), { ...tts, engineChosen: true }, installed, undefined, slow);
    expect(choice).toMatchObject({ engines: { tts: { engine: 'system', voice: 'Samantha' } } });
  });
});

describe('chooseEconomyEngines', () => {
  it('says plainly, with where to look, when no speech model is there (no developer command)', () => {
    const choice = chooseEconomyEngines(settings(), tts, { kitten: { bytes: 1 } });
    expect(choice).toEqual({ error: expect.stringContaining('Voice engines') });
    expect(JSON.stringify(choice)).not.toContain(SETUP_COMMAND);
  });

  it('speaks a conversation with KittenTTS when the system voices were never picked', () => {
    const choice = chooseEconomyEngines(
      settings(),
      { ...tts, engineChosen: false },
      { 'moonshine-tiny': { bytes: 1 }, kitten: { bytes: 1 } },
    );
    expect(choice).toMatchObject({ engines: { tts: { engine: 'kitten', voice: 'Bella' } } });
  });

  it('hears with Moonshine on the GPU and speaks with KittenTTS when chosen', () => {
    const choice = chooseEconomyEngines(
      settings({ stt: 'moonshine', kittenVoice: 'Leo' }),
      { ...tts, engine: 'kitten' },
      { 'moonshine-tiny': { bytes: 1, webgpu: true }, kitten: { bytes: 1 } },
    );
    expect(choice).toEqual({
      engines: {
        stt: { engine: 'moonshine', model: 'moonshine-tiny', webgpu: true },
        tts: { engine: 'kitten', voice: 'Leo', rate: 1.1 },
      },
    });
  });

  it('keeps the system voice name for the system voices, and never speaks with Gemini', () => {
    const system = chooseEconomyEngines(settings({ stt: 'vosk' }), tts, { vosk: { bytes: 1 } });
    expect(system).toEqual({
      engines: { stt: { engine: 'vosk', webgpu: false }, tts: { engine: 'system', voice: 'Samantha', rate: 1.1 } },
    });
    const gemini = chooseEconomyEngines(
      settings({ stt: 'whisper' }),
      { ...tts, engine: 'gemini' },
      {
        'whisper-base': { bytes: 1 },
        kitten: { bytes: 1 },
      },
    );
    expect(gemini).toMatchObject({ engines: { tts: { engine: 'kitten', voice: 'Bella' } } });
  });
});

describe('parseVoiceManifest', () => {
  it('reads the models the setup script installed, and nothing else', () => {
    expect(
      parseVoiceManifest({
        version: 1,
        components: {
          kitten: { bytes: 27648149, webgpu: false },
          'moonshine-tiny': { bytes: 107612650, webgpu: true },
          'evil-model': { bytes: 1 },
        },
      }),
    ).toEqual({ kitten: { bytes: 27648149 }, 'moonshine-tiny': { bytes: 107612650, webgpu: true } });
    expect(parseVoiceManifest(null)).toEqual({});
    expect(parseVoiceManifest({ components: 'nope' })).toEqual({});
  });
});

describe('voice tools for a text model', () => {
  it("turns Gemini's schema dialect into JSON Schema", () => {
    expect(
      toJsonSchema({
        type: 'OBJECT',
        properties: {
          tab_id: { type: 'INTEGER', description: 'a tab id' },
          use_page: { type: 'BOOLEAN' },
          question: { type: 'STRING' },
          odd: { type: 'SOMETHING' },
        },
        required: ['question'],
      }),
    ).toEqual({
      type: 'object',
      properties: {
        tab_id: { type: 'integer', description: 'a tab id' },
        use_page: { type: 'boolean' },
        question: { type: 'string' },
        odd: { type: 'string' },
      },
      required: ['question'],
      additionalProperties: false,
    });
    expect(toJsonSchema(undefined)).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('runs each tool through the voice manager with its own name', async () => {
    const run = vi.fn(async () => 'ok');
    const tools = voiceToolSet(
      [
        { name: 'get_status', description: 'status' },
        {
          name: 'open_tab',
          description: 'open',
          parameters: { type: 'OBJECT', properties: { target: { type: 'STRING' } } },
        },
      ],
      run,
    );
    expect(Object.keys(tools)).toEqual(['get_status', 'open_tab']);
    const execute = tools.open_tab.execute as (input: unknown, options: unknown) => Promise<string>;
    await expect(execute({ target: 'github.com' }, { toolCallId: '1', messages: [] })).resolves.toBe('ok');
    expect(run).toHaveBeenCalledWith('open_tab', { target: 'github.com' });
  });
});

describe('idle end', () => {
  const base = { running: true, idleMinutes: 3, lastActivity: 0, now: 3 * 60_000, tasksBusy: false };

  it('ends a conversation quiet for the minutes set', () => {
    expect(shouldEndIdle(base)).toBe(true);
    expect(shouldEndIdle({ ...base, now: 3 * 60_000 - 1 })).toBe(false);
  });

  it('never ends one with a task running or waiting, one set to never, or none at all', () => {
    expect(shouldEndIdle({ ...base, tasksBusy: true })).toBe(false);
    expect(shouldEndIdle({ ...base, idleMinutes: 0 })).toBe(false);
    expect(shouldEndIdle({ ...base, running: false })).toBe(false);
  });

  it('counts turns, tools and status changes as activity, but not the end', () => {
    expect(isVoiceActivity({ type: 'voice_turn' })).toBe(true);
    expect(isVoiceActivity({ type: 'voice_tool' })).toBe(true);
    expect(isVoiceActivity({ type: 'voice_engine_turn' })).toBe(true);
    expect(isVoiceActivity({ type: 'voice_status', status: 'speaking' })).toBe(true);
    expect(isVoiceActivity({ type: 'voice_status', status: 'off' })).toBe(false);
    expect(isVoiceActivity({ type: 'tts_ended' })).toBe(false);
    expect(isVoiceActivity(null)).toBe(false);
  });
});

describe('modelsNeeded', () => {
  const base = {
    settings: { ...DEFAULT_VOICE_ENGINE_SETTINGS },
    tts: { engine: 'system', engineChosen: false },
    installed: {},
    hasGeminiKey: false,
    geminiSpeechToText: false,
  };

  it('asks for Moonshine tiny and KittenTTS before the first conversation on the device', () => {
    expect(modelsNeeded('talk', base)).toEqual({ required: ['moonshine-tiny'], optional: ['kitten'] });
  });

  it('asks for nothing once they are here, or when the conversation goes to Gemini Live', () => {
    const installed = { 'moonshine-tiny': { bytes: 1 }, kitten: { bytes: 1 } };
    expect(modelsNeeded('talk', { ...base, installed })).toEqual({ required: [], optional: [] });
    // Automatic with a Gemini key and nothing downloaded: Live, as before
    expect(modelsNeeded('talk', { ...base, hasGeminiKey: true })).toEqual({ required: [], optional: [] });
    expect(
      modelsNeeded('talk', { ...base, hasGeminiKey: true, settings: { ...base.settings, mode: 'economy' } }),
    ).toEqual({ required: ['moonshine-tiny'], optional: ['kitten'] });
  });

  it('follows the engines chosen: the system voices picked need no voice download', () => {
    expect(modelsNeeded('talk', { ...base, tts: { engine: 'system', engineChosen: true } }).optional).toEqual([]);
    expect(modelsNeeded('talk', { ...base, tts: { engine: 'kokoro', engineChosen: true } }).optional).toEqual([
      'kokoro',
    ]);
    expect(modelsNeeded('talk', { ...base, settings: { ...base.settings, stt: 'whisper' } }).required).toEqual([
      'whisper-base',
    ]);
  });

  it('dictation needs a recogniser unless Gemini writes it down; the wake word needs Vosk', () => {
    expect(modelsNeeded('dictation', base)).toEqual({ required: ['moonshine-tiny'], optional: [] });
    expect(modelsNeeded('dictation', { ...base, geminiSpeechToText: true })).toEqual({ required: [], optional: [] });
    expect(modelsNeeded('wake', base)).toEqual({ required: ['vosk'], optional: [] });
    expect(modelsNeeded('wake', { ...base, installed: { vosk: { bytes: 1 } } })).toEqual({
      required: [],
      optional: [],
    });
  });
});
