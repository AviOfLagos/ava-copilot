import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@extension/i18n', () => ({ t: (key: string) => key }));
vi.mock('../../services/speechToText', () => ({ SpeechToTextService: { create: vi.fn() } }));
vi.mock('../engines/models', () => ({ installedVoiceModels: vi.fn(async () => ({})) }));
vi.mock('../engines/offscreen', () => ({ toVoiceOffscreen: vi.fn() }));
vi.mock('../../offscreen', () => ({ toOffscreen: vi.fn(async () => ({ ok: true })) }));
vi.mock('../../registry', () => ({ registerOffscreenBusy: vi.fn() }));
vi.mock('@extension/storage', () => ({
  llmProviderStore: { getAllProviders: vi.fn(async () => ({})) },
  speechToTextModelStore: { getSpeechToTextModel: vi.fn(async () => null) },
  voiceEngineSettingsStore: { getSettings: vi.fn(async () => ({})) },
  localSttChoice: vi.fn(() => null),
}));

const {
  dictationBusy,
  hasGeminiSpeechToText,
  holdForDictation,
  isChannelError,
  releaseDictation,
  sttErrorMessage,
  transcribeLocalFirst,
  transcribeSpeech,
} = await import('../dictation');
const { AppError } = await import('@extension/shared');
const { registerOffscreenBusy } = await import('../../registry');
// Registered when the module loads, before any test clears the mocks
const busyChecks = vi.mocked(registerOffscreenBusy).mock.calls.map(call => [...call]);

// What Chrome says when the offscreen document closes while it writes the words down
const CHANNEL_CLOSED =
  'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received';
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

  it('keeps the offscreen document open while it writes the words down', async () => {
    const check = busyChecks.find(call => call[0] === 'dictation')?.[1] as () => Promise<boolean>;
    expect(check).toBeTypeOf('function');
    let finish!: (text: string) => void;
    const d = deps();
    d.local.mockImplementation(() => new Promise<string>(resolve => (finish = resolve)));
    const words = transcribeSpeech('AAAA', 'audio/webm', d);
    await vi.waitFor(() => expect(d.local).toHaveBeenCalled());
    expect(dictationBusy()).toBe(true);
    expect(await check()).toBe(true);
    finish('hello');
    expect(await words).toBe('hello');
    expect(dictationBusy()).toBe(false);

    d.local.mockRejectedValue(new Error('broken'));
    await expect(transcribeSpeech('AAAA', 'audio/webm', d)).rejects.toThrow('broken');
    expect(dictationBusy()).toBe(false);
  });

  it('tries once more when the offscreen document went away mid-way, and the words still arrive', async () => {
    const d = deps();
    d.local.mockRejectedValueOnce(new Error(CHANNEL_CLOSED)).mockResolvedValueOnce('send the invoice');
    expect(await transcribeSpeech('AAAA', 'audio/webm', d)).toBe('send the invoice');
    expect(d.local).toHaveBeenCalledTimes(2);
  });

  it("says it plainly, never Chrome's words, when the offscreen document cannot answer", async () => {
    const d = deps();
    d.local.mockRejectedValue(new Error(CHANNEL_CLOSED));
    const error = await transcribeSpeech('AAAA', 'audio/webm', d).catch(caught => caught);
    expect(d.local).toHaveBeenCalledTimes(2);
    expect(sttErrorMessage(error)).toBe('chat_stt_unanswered');
    expect(isChannelError(new Error('Could not establish connection. Receiving end does not exist.'))).toBe(true);
    expect(isChannelError(new Error('The message port closed before a response was received.'))).toBe(true);
    expect(sttErrorMessage(new Error('Gemini said no'))).toBe('Gemini said no');
    expect(sttErrorMessage('odd')).toBe('bg_cmd_stt_failed');
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

describe('a WhatsApp voice note: written down on this computer first', () => {
  const deps = () => ({
    geminiReady: vi.fn(async () => true),
    gemini: vi.fn(async () => 'from gemini'),
    local: vi.fn(async () => 'from this computer'),
  });

  it('uses the local recogniser even when Gemini is set up', async () => {
    const d = deps();
    expect(await transcribeLocalFirst('data:audio/ogg;base64,T2dn', 'audio/ogg', d)).toBe('from this computer');
    expect(d.local).toHaveBeenCalledWith('T2dn');
    expect(d.gemini).not.toHaveBeenCalled();
  });

  it('falls back to Gemini only when no local recogniser is installed', async () => {
    const d = deps();
    d.local.mockRejectedValue(new AppError('not_found', 'voice_engine_dictation_missing'));
    expect(await transcribeLocalFirst('T2dn', 'audio/ogg; codecs=opus', d)).toBe('from gemini');
    expect(d.gemini).toHaveBeenCalledWith('T2dn', 'audio/ogg; codecs=opus');
    d.geminiReady.mockResolvedValue(false);
    await expect(transcribeLocalFirst('T2dn', 'audio/ogg', d)).rejects.toThrow('voice_engine_dictation_missing');
    // A recogniser that failed on the recording is not a reason to send it elsewhere
    const broken = deps();
    broken.local.mockRejectedValue(new Error('could not decode'));
    await expect(transcribeLocalFirst('T2dn', 'audio/ogg', broken)).rejects.toThrow('could not decode');
    expect(broken.gemini).not.toHaveBeenCalled();
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
