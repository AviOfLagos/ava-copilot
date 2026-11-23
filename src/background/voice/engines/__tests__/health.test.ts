import { beforeEach, describe, expect, it, vi } from 'vitest';

// storage's base.ts reads globalThis.chrome when it is imported, so the mock must exist before the import
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

vi.mock('@extension/i18n', () => ({ t: (key: string) => key }));

const { voiceHealthStore, voiceTraceStore } = await import('@extension/storage');
const { recordHearingTrouble, recordSpoken, slowVoice } = await import('../health');

const report = (changes: Record<string, unknown> = {}) => ({
  engine: 'kitten' as const,
  ok: true,
  chars: 180,
  audioSeconds: 12,
  workMs: 16_000,
  speed: 0.75,
  firstAudioMs: 6000,
  loadMs: null,
  gaps: { count: 3, totalMs: 3600, longestMs: 2400 },
  ...changes,
});

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
});

describe('recordSpoken', () => {
  it("writes a line with sizes and times, the pauses heard, and moves the voice's measured speed", async () => {
    await recordSpoken(report());
    const [entry] = await voiceTraceStore.getEntries();
    expect(entry).toMatchObject({
      kind: 'tts',
      engine: 'kitten',
      ok: true,
      chars: 180,
      speed: 0.75,
      firstAudioMs: 6000,
      gaps: { count: 3, totalMs: 3600, longestMs: 2400 },
    });
    expect(Object.keys(entry)).not.toContain('text');
    expect((await voiceHealthStore.getHealth()).tts.kitten).toMatchObject({ speed: 0.75, source: 'observed' });
  });

  it('keeps no pause figures when there were none, and does not rate a very short answer', async () => {
    await recordSpoken(report({ chars: 10, audioSeconds: 0.9, gaps: { count: 0, totalMs: 0, longestMs: 0 } }));
    const [entry] = await voiceTraceStore.getEntries();
    expect(entry).not.toHaveProperty('gaps');
    expect((await voiceHealthStore.getHealth()).tts.kitten).toBeUndefined();
  });

  it('records a failure without moving the speed', async () => {
    await recordSpoken(report({ ok: false, speed: null, note: 'failed' }));
    expect((await voiceTraceStore.getEntries())[0]).toMatchObject({ ok: false, note: 'failed' });
    expect((await voiceHealthStore.getHealth()).tts.kitten).toBeUndefined();
  });
});

describe('slowVoice', () => {
  const slow = { tts: { kokoro: { speed: 0.3, at: Date.now(), source: 'observed' as const } } };

  it('names the local voice that is too slow for the length it must say', () => {
    expect(slowVoice('kokoro', slow, 300)).toEqual({ engine: 'kokoro', speed: 0.3 });
    expect(slowVoice('kokoro', slow, 40)).toBeNull();
  });

  it('never replaces the system voices or the cloud', () => {
    expect(slowVoice('system', slow)).toBeNull();
    expect(slowVoice('gemini', slow)).toBeNull();
    expect(slowVoice('kitten', slow)).toBeNull();
  });
});

describe('recordHearingTrouble', () => {
  it('leaves a code in the trace, never words, and ignores anything else', async () => {
    await recordHearingTrouble('unclear-turns', 'whisper');
    await recordHearingTrouble('my secret words', 'whisper');
    const entries = (await voiceTraceStore.get()).entries.filter(entry => entry.note === 'unclear-turns');
    expect(entries.at(-1)).toMatchObject({ kind: 'stt', engine: 'whisper', ok: false, note: 'unclear-turns' });
    expect(JSON.stringify(await voiceTraceStore.get())).not.toContain('secret');
  });
});
