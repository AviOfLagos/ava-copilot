import { beforeEach, describe, expect, it, vi } from 'vitest';

// base.ts reads globalThis.chrome when it is imported, so the mock must exist before the import
const store = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]])),
        set: async (items: Record<string, unknown>) => Object.assign(data, items),
        onChanged: { addListener: () => undefined },
      },
    },
  });
  return data;
});

const {
  DEFAULT_VOICE_ENGINE_SETTINGS,
  economyStt,
  economyTts,
  localSttChoice,
  hearsOnDevice,
  localVoice,
  migrateVoiceEngineSettings,
  resolveVoiceMode,
  sttModelId,
  threadTts,
  threadVoiceEngines,
  voiceEngineSettingsStore,
  voiceTtsEngine,
} = await import('../voiceEngineSettings');

const settings = (changes: Partial<typeof DEFAULT_VOICE_ENGINE_SETTINGS> = {}) => ({
  ...DEFAULT_VOICE_ENGINE_SETTINGS,
  ...changes,
});

describe('voiceEngineSettingsStore', () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
  });

  it('starts on the device (auto) with Moonshine hearing and KittenTTS Bella as the local voice', async () => {
    const value = await voiceEngineSettingsStore.getSettings();
    expect(value).toEqual(DEFAULT_VOICE_ENGINE_SETTINGS);
    expect(value.mode).toBe('auto');
    expect(value.modeChosen).toBe(false);
    expect(value.stt).toBe('moonshine');
    expect(value.idleEndMinutes).toBe(3);
  });

  it('moves an install that never picked a mode to auto, and keeps a mode that was picked', async () => {
    // Every save before 'auto' wrote the old default 'live', whatever the user changed
    store['voice-engine-settings'] = { ...DEFAULT_VOICE_ENGINE_SETTINGS, mode: 'live', modeChosen: undefined };
    expect((await voiceEngineSettingsStore.getSettings()).mode).toBe('auto');
    // Economy was never a default: it was picked
    store['voice-engine-settings'] = { mode: 'economy' };
    expect(await voiceEngineSettingsStore.getSettings()).toMatchObject({ mode: 'economy', modeChosen: true });
    // Live picked in Settings stays Live
    store['voice-engine-settings'] = { mode: 'live', modeChosen: true };
    expect((await voiceEngineSettingsStore.getSettings()).mode).toBe('live');
    expect(migrateVoiceEngineSettings({ mode: 'nonsense' as never }).mode).toBe('auto');
    expect(migrateVoiceEngineSettings(null)).toEqual(DEFAULT_VOICE_ENGINE_SETTINGS);
  });

  it('merges changes into what is saved, and fills fields saved before they existed', async () => {
    store['voice-engine-settings'] = { mode: 'economy' };
    await voiceEngineSettingsStore.updateSettings({ stt: 'moonshine' });
    expect(store['voice-engine-settings']).toEqual({
      ...DEFAULT_VOICE_ENGINE_SETTINGS,
      mode: 'economy',
      modeChosen: true,
      stt: 'moonshine',
    });
  });

  it('keeps the voice engine in the one setting Voice output reads too', async () => {
    store['tts-settings'] = { readAloud: 'always', engine: 'system', voice: 'Samantha', rate: 1.2 };
    await voiceEngineSettingsStore.setTtsEngine('kitten');
    expect(store['tts-settings']).toMatchObject({
      readAloud: 'always',
      engine: 'kitten',
      voice: 'Samantha',
      rate: 1.2,
    });
    expect(await voiceEngineSettingsStore.getTtsEngine()).toBe('kitten');
  });

  it('reads an unknown stored engine as the system voices', async () => {
    store['tts-settings'] = { engine: 'something-else' };
    expect(await voiceEngineSettingsStore.getTtsEngine()).toBe('system');
    expect(voiceTtsEngine(undefined)).toBe('system');
    expect(voiceTtsEngine('kokoro')).toBe('kokoro');
  });
});

describe('engine choice for economy conversations', () => {
  it('hears with the local engine chosen when it is installed', () => {
    expect(
      economyStt(settings({ stt: 'whisper' }), { 'whisper-base': { bytes: 1 }, 'moonshine-tiny': { bytes: 1 } }),
    ).toBe('whisper');
    expect(economyStt(settings({ stt: 'vosk' }), { vosk: { bytes: 1 } })).toBe('vosk');
  });

  it('never hears with Gemini: the first local engine installed stands in, Moonshine first', () => {
    expect(economyStt(settings({ stt: 'gemini' }), { vosk: { bytes: 1 }, 'moonshine-tiny': { bytes: 1 } })).toBe(
      'moonshine',
    );
    expect(economyStt(settings({ stt: 'gemini' }), { vosk: { bytes: 1 } })).toBe('vosk');
    expect(economyStt(settings({ stt: 'gemini' }), {})).toBeNull();
  });

  it('takes the other Moonshine size when the chosen one is missing', () => {
    const installed = { 'moonshine-tiny': { bytes: 1 } };
    expect(economyStt(settings({ stt: 'moonshine', moonshineSize: 'base' }), installed)).toBe('moonshine');
    expect(localSttChoice(settings({ stt: 'moonshine', moonshineSize: 'base' }), installed)).toEqual({
      engine: 'moonshine',
      model: 'moonshine-tiny',
      webgpu: false,
    });
  });

  it('uses the graphics card only when allowed and its weights are installed', () => {
    const installed = { 'moonshine-base': { bytes: 1, webgpu: true }, 'whisper-base': { bytes: 1 } };
    expect(localSttChoice(settings({ stt: 'moonshine', moonshineSize: 'base' }), installed)?.webgpu).toBe(true);
    expect(
      localSttChoice(settings({ stt: 'moonshine', moonshineSize: 'base', sttGpu: false }), installed)?.webgpu,
    ).toBe(false);
    expect(localSttChoice(settings({ stt: 'whisper' }), installed)).toEqual({
      engine: 'whisper',
      model: 'whisper-base',
      webgpu: false,
    });
    expect(localSttChoice(settings({ stt: 'vosk' }), { vosk: { bytes: 1 } })).toEqual({
      engine: 'vosk',
      webgpu: false,
    });
  });

  it('names the model folder of each engine', () => {
    expect(sttModelId('moonshine', 'tiny')).toBe('moonshine-tiny');
    expect(sttModelId('moonshine', 'base')).toBe('moonshine-base');
    expect(sttModelId('whisper', 'tiny')).toBe('whisper-base');
    expect(sttModelId('vosk', 'base')).toBe('vosk');
  });

  it('speaks with a local voice when chosen and installed, else KittenTTS, else the system voices; never Gemini', () => {
    expect(economyTts('kokoro', { kokoro: { bytes: 1 } })).toBe('kokoro');
    expect(economyTts('kokoro', { kitten: { bytes: 1 } })).toBe('kitten');
    expect(economyTts('gemini', { kitten: { bytes: 1 } })).toBe('kitten');
    expect(economyTts('gemini', {})).toBe('system');
    expect(economyTts('system', { kitten: { bytes: 1 } })).toBe('system');
    // The system voices left at their default give way to KittenTTS in a conversation
    expect(economyTts('system', { kitten: { bytes: 1 } }, false)).toBe('kitten');
    expect(economyTts('system', {}, false)).toBe('system');
  });

  it('talks through Gemini Live with a key, on the device without one or when economy is picked', () => {
    expect(resolveVoiceMode({ mode: 'auto' }, { hasGeminiKey: true })).toBe('live');
    expect(resolveVoiceMode({ mode: 'auto' }, { hasGeminiKey: false })).toBe('economy');
    expect(resolveVoiceMode({ mode: 'live' }, { hasGeminiKey: true })).toBe('live');
    expect(resolveVoiceMode({ mode: 'live' }, { hasGeminiKey: false })).toBe('economy');
    expect(resolveVoiceMode({ mode: 'economy' }, { hasGeminiKey: true })).toBe('economy');
  });

  it('keeps speech on this computer when the user chose that, also with a key', () => {
    const key = { hasGeminiKey: true };
    expect(resolveVoiceMode({ mode: 'auto', stt: 'whisper', sttChosen: true }, key)).toBe('economy');
    expect(resolveVoiceMode({ mode: 'auto', stt: 'moonshine', sttChosen: false }, key)).toBe('live');
    expect(hearsOnDevice(settings({ mode: 'economy' }))).toBe(true);
    expect(hearsOnDevice(settings({ stt: 'whisper', sttChosen: true }))).toBe(true);
    expect(hearsOnDevice(settings())).toBe(false);
    // A chat's own choice goes over Settings, both ways
    expect(hearsOnDevice(threadVoiceEngines(settings({ mode: 'economy' }), { hear: 'gemini' }))).toBe(false);
    expect(hearsOnDevice(threadVoiceEngines(settings(), { hear: 'vosk' }))).toBe(true);
    expect(threadVoiceEngines(settings(), { speak: 'kokoro' }).mode).toBe('economy');
  });

  it("always tells Whisper the user's language, even where the engine is not upgraded for hearing", () => {
    const installed = { 'whisper-base': {} } as never;
    expect(localSttChoice(settings({ stt: 'whisper' }), installed, undefined, 'pt-BR')).toMatchObject({
      engine: 'whisper',
      language: 'pt',
    });
    // English-only recognisers are left as they are
    const moonshine = { 'moonshine-tiny': {} } as never;
    expect(localSttChoice(settings(), moonshine, undefined, 'pt-BR')).not.toHaveProperty('language');
  });

  it('answers voice with the chat model by default; an old untouched "fast" becomes it, a picked one stays', () => {
    expect(DEFAULT_VOICE_ENGINE_SETTINGS.economyModel).toBe('chat');
    expect(migrateVoiceEngineSettings({ economyModel: 'fast' }).economyModel).toBe('chat');
    expect(migrateVoiceEngineSettings({ economyModel: 'fast', economyModelChosen: true }).economyModel).toBe('fast');
    const local = migrateVoiceEngineSettings({ economyModel: 'local' });
    expect(local.economyModel).toBe('local');
    expect(local.economyModelChosen).toBe(true);
    expect(migrateVoiceEngineSettings({ economyModel: 'nonsense' as never }).economyModel).toBe('chat');
  });

  it('hears the user with Whisper when installed, unless another recogniser was picked', () => {
    const installed = { 'moonshine-tiny': {}, 'whisper-base': {} } as never;
    const hearing = { language: 'en-NG' };
    expect(localSttChoice(settings(), installed, hearing)).toMatchObject({ engine: 'whisper', language: 'en' });
    expect(localSttChoice(settings({ sttChosen: true }), installed, hearing)?.engine).toBe('moonshine');
    // Always-on listening stays on the light recogniser
    expect(localSttChoice(settings(), installed)?.engine).toBe('moonshine');
    // Only Whisper knows other languages, whatever was picked
    expect(localSttChoice(settings({ sttChosen: true }), installed, { language: 'cmn-CN' })).toMatchObject({
      engine: 'whisper',
      language: 'zh',
    });
    expect(localSttChoice(settings(), { 'moonshine-tiny': {} } as never, hearing)?.engine).toBe('moonshine');
  });

  it('lets a chat override who hears and speaks', () => {
    expect(threadVoiceEngines(settings(), null)).toEqual(settings());
    expect(threadVoiceEngines(settings(), { hear: 'gemini' }).mode).toBe('live');
    expect(threadVoiceEngines(settings(), { speak: 'gemini' }).mode).toBe('live');
    expect(threadVoiceEngines(settings(), { hear: 'whisper' })).toMatchObject({
      mode: 'economy',
      stt: 'whisper',
      sttChosen: true,
    });
    expect(threadVoiceEngines(settings(), { hear: 'whisper', speak: 'gemini' }).mode).toBe('economy');
    expect(threadTts({ engine: 'system', engineChosen: false }, { speak: 'kokoro' })).toEqual({
      engine: 'kokoro',
      engineChosen: true,
    });
    expect(threadTts({ engine: 'system' }, { language: 'fr-FR' })).toEqual({ engine: 'system' });
  });

  it("keeps a voice only when it is one of the engine's", () => {
    expect(localVoice('kitten', settings({ kittenVoice: 'Leo' }))).toBe('Leo');
    expect(localVoice('kitten', settings({ kittenVoice: 'Samantha' }))).toBe('Bella');
    expect(localVoice('kokoro', settings({ kokoroVoice: 'bm_george' }))).toBe('bm_george');
    expect(localVoice('kokoro', settings({ kokoroVoice: 'Leo' }))).toBe('af_heart');
  });
});
