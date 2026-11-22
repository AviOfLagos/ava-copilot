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
  blendSpeed,
  localTtsUsable,
  SHORT_LINE_CHARS,
  STALE_BENCHMARK_MS,
  STALE_OBSERVED_MS,
  sttVerdict,
  ttsVerdict,
  VOICE_TRACE_LIMIT,
  voiceHealthStore,
  voiceTraceStore,
  worthRecording,
} = await import('../voiceHealth');

describe('ttsVerdict', () => {
  it('says what a speed means for the listener', () => {
    expect(ttsVerdict(undefined)).toBe('unknown');
    expect(ttsVerdict(0)).toBe('unknown');
    expect(ttsVerdict(Number.NaN)).toBe('unknown');
    expect(ttsVerdict(3)).toBe('fast');
    expect(ttsVerdict(1.4)).toBe('steady');
    expect(ttsVerdict(1)).toBe('borderline');
    // The speed measured on an Apple M3 in the browser, KittenTTS nano
    expect(ttsVerdict(0.73)).toBe('too-slow');
  });

  it('judges a recogniser on its own scale', () => {
    expect(sttVerdict(4)).toBe('fast');
    expect(sttVerdict(1.6)).toBe('steady');
    expect(sttVerdict(1.1)).toBe('borderline');
    expect(sttVerdict(0.8)).toBe('too-slow');
  });
});

describe('localTtsUsable', () => {
  const slow = (at = Date.now()) => ({ tts: { kitten: { speed: 0.7, at, source: 'observed' as const } } });

  it('gives a voice nobody measured the benefit of the doubt', () => {
    expect(localTtsUsable('kitten', { tts: {} })).toBe(true);
  });

  it('lets a slow voice say one short line, and no more', () => {
    expect(localTtsUsable('kitten', slow(), SHORT_LINE_CHARS)).toBe(true);
    expect(localTtsUsable('kitten', slow(), SHORT_LINE_CHARS + 1)).toBe(false);
    expect(localTtsUsable('kitten', slow())).toBe(false);
  });

  it('tries a voice again once its reading is old: soon for answers (a busy spell passes), later for a check', () => {
    const now = Date.now();
    expect(localTtsUsable('kitten', slow(now - STALE_OBSERVED_MS + 1000), 500, now)).toBe(false);
    expect(localTtsUsable('kitten', slow(now - STALE_OBSERVED_MS - 1), 500, now)).toBe(true);
    const checked = (at: number) => ({ tts: { kitten: { speed: 0.7, at, source: 'benchmark' as const } } });
    expect(localTtsUsable('kitten', checked(now - STALE_OBSERVED_MS - 1), 500, now)).toBe(false);
    expect(localTtsUsable('kitten', checked(now - STALE_BENCHMARK_MS - 1), 500, now)).toBe(true);
  });

  it('judges each engine by its own reading', () => {
    expect(localTtsUsable('kokoro', slow())).toBe(true);
  });
});

describe('blendSpeed and worthRecording', () => {
  it('moves a reading gently, a benchmark more than an answer', () => {
    expect(blendSpeed(undefined, 0.7, 1)).toEqual({ speed: 0.7, at: 1, source: 'observed' });
    expect(blendSpeed({ speed: 2, at: 0, source: 'observed' }, 1, 1).speed).toBe(1.5);
    expect(blendSpeed({ speed: 2, at: 0, source: 'benchmark' }, 1, 1).speed).toBe(1.7);
  });

  it('ignores very short answers: their time is mostly start-up', () => {
    expect(worthRecording(10, 1)).toBe(false);
    expect(worthRecording(80, 1)).toBe(false);
    expect(worthRecording(80, 5)).toBe(true);
  });
});

describe('the stores', () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
  });

  it('keeps a benchmark reading as it was measured and blends the answers after it', async () => {
    await voiceHealthStore.recordTtsSpeed('kitten', 2, 'benchmark');
    expect((await voiceHealthStore.getHealth()).tts.kitten).toMatchObject({ speed: 2, source: 'benchmark' });
    await voiceHealthStore.recordTtsSpeed('kitten', 1, 'observed');
    expect((await voiceHealthStore.getHealth()).tts.kitten).toMatchObject({ speed: 1.7, source: 'observed' });
  });

  it('keeps the newest trace lines only', async () => {
    for (let i = 0; i < VOICE_TRACE_LIMIT + 5; i++) {
      await voiceTraceStore.append({ at: i, kind: 'tts', engine: 'kitten', ok: true });
    }
    const entries = await voiceTraceStore.getEntries();
    expect(entries).toHaveLength(VOICE_TRACE_LIMIT);
    expect(entries.at(-1)?.at).toBe(VOICE_TRACE_LIMIT + 4);
    await voiceTraceStore.clear();
    expect(await voiceTraceStore.getEntries()).toEqual([]);
  });
});
