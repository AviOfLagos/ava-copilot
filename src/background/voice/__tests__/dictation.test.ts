import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@extension/i18n', () => ({ t: (key: string) => key }));
vi.mock('../../services/speechToText', () => ({ SpeechToTextService: { create: vi.fn() } }));
vi.mock('../engines/models', () => ({ installedVoiceModels: vi.fn(async () => ({})) }));
vi.mock('../engines/offscreen', () => ({ toVoiceOffscreen: vi.fn() }));
vi.mock('../../offscreen', () => ({ toOffscreen: vi.fn(async () => ({ ok: true })) }));
vi.mock('@extension/storage', () => ({
  llmProviderStore: { getAllProviders: vi.fn(async () => ({})) },
  speechToTextModelStore: { getSpeechToTextModel: vi.fn(async () => null) },
  voiceEngineSettingsStore: { getSettings: vi.fn(async () => ({})) },
  localSttChoice: vi.fn(() => null),
}));

const { hasGeminiSpeechToText, holdForDictation, releaseDictation, transcribeSpeech } = await import('../dictation');
const { toOffscreen } = await import('../../offscreen');

describe('dictation: writing the words down', () => {
  const deps = () => ({
    geminiReady: vi.fn(async () => false),
    gemini: vi.fn(async () => 'from gemini'),
    local: vi.fn(async () => 'from this computer'),
  });

  it('writes the words down on this computer when no Gemini speech-to-text is set up', async () => {
    const d = deps();
    expect(await transcribeSpeech('data:audio/webm;base64,AAAA', 'audio/webm', d)).toBe('from this computer');
    expect(d.local).toHaveBeenCalledWith('AAAA');
    expect(d.gemini).not.toHaveBeenCalled();
  });

  it('uses Gemini when its speech-to-text is set up', async () => {
    const d = deps();
    d.geminiReady.mockResolvedValue(true);
    expect(await transcribeSpeech('BBBB', 'audio/wav', d)).toBe('from gemini');
    expect(d.gemini).toHaveBeenCalledWith('BBBB', 'audio/wav');
    expect(d.local).not.toHaveBeenCalled();
  });

  it('says plainly what to set up when neither is there', async () => {
    await expect(transcribeSpeech('AAAA')).rejects.toThrow('voice_engine_dictation_missing');
  });

  it('counts Gemini speech-to-text as set up only with a model on a Gemini provider that has a key', () => {
    const gemini = { type: 'gemini', apiKey: 'k' } as never;
    expect(hasGeminiSpeechToText({ provider: 'g', modelName: 'm' }, { g: gemini })).toBe(true);
    expect(hasGeminiSpeechToText(null, { g: gemini })).toBe(false);
    expect(
      hasGeminiSpeechToText({ provider: 'g', modelName: 'm' }, { g: { type: 'gemini', apiKey: '' } as never }),
    ).toBe(false);
    expect(
      hasGeminiSpeechToText({ provider: 'o', modelName: 'm' }, { o: { type: 'openai', apiKey: 'k' } as never }),
    ).toBe(false);
  });
});

describe('dictation: holding the microphone', () => {
  let open = 1;
  beforeEach(() => {
    open = 1;
    vi.mocked(toOffscreen).mockClear();
    vi.stubGlobal('chrome', {
      runtime: {
        ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
        getContexts: async () => Array.from({ length: open }, () => ({})),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('holds the conversation and the wake word while dictating, and gives them back after', async () => {
    const panel = {};
    await holdForDictation(true, panel);
    await holdForDictation(false, panel);
    expect(vi.mocked(toOffscreen).mock.calls.map(call => call[0])).toEqual([
      { type: 'dictation_hold', on: true },
      { type: 'dictation_hold', on: false },
    ]);
  });

  it('gives the microphone back when the dictating panel closes, but not for another panel', async () => {
    const panel = {};
    const other = {};
    await holdForDictation(true, panel);
    releaseDictation(other);
    await holdForDictation(false, other);
    expect(vi.mocked(toOffscreen)).toHaveBeenCalledTimes(1);
    releaseDictation(panel);
    await vi.waitFor(() =>
      expect(vi.mocked(toOffscreen)).toHaveBeenLastCalledWith({ type: 'dictation_hold', on: false }),
    );
  });

  it('opens nothing just to hold: with no offscreen document nothing is listening', async () => {
    open = 0;
    await holdForDictation(true, {});
    expect(toOffscreen).not.toHaveBeenCalled();
    await holdForDictation(false, null);
  });
});
