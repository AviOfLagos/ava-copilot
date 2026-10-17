import { describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({
  load: vi.fn(async () => ({ device: 'wasm' as const, ms: 1 })),
  transcribe: vi.fn(async (audio: Float32Array) => `words ${audio.length > 0 ? 'heard' : ''}`),
  dispose: vi.fn(),
}));
vi.mock('../pool', () => ({ acquireStt: vi.fn(async () => engine), releaseStt: vi.fn() }));

const { splitUtterances, transcribeRecording } = await import('../transcribe');
const { releaseStt } = await import('../pool');

const RATE = 16_000;
const tone = (seconds: number) =>
  Float32Array.from({ length: seconds * RATE }, (_, i) => 0.2 * Math.sin((i / RATE) * 2 * Math.PI * 220));
const silence = (seconds: number) => new Float32Array(seconds * RATE);
const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

describe('a dictated recording written down on the device', () => {
  it('is cut at the pauses, with the silence left out, and ends a last word cut off mid-way', () => {
    const parts = splitUtterances(join(silence(1), tone(1), silence(1.5), tone(2)));
    expect(parts).toHaveLength(2);
    // The word, its lead-in and the pause after it, but not the second of silence before
    expect(parts[0].length).toBeLessThan(2.5 * RATE);
    expect(parts[1].length).toBeGreaterThanOrEqual(2 * RATE);
  });

  it('writes each part down in order and joins the words, then gives the recogniser back', async () => {
    const decode = vi.fn(async () => join(tone(1), silence(1.5), tone(1)));
    const text = await transcribeRecording({ engine: 'moonshine', model: 'moonshine-tiny' }, btoa('webm'), decode);
    expect(text).toBe('words heard words heard');
    expect(engine.transcribe).toHaveBeenCalledTimes(2);
    expect(releaseStt).toHaveBeenCalledTimes(1);
  });

  it('is empty for silence, without loading the recogniser', async () => {
    engine.transcribe.mockClear();
    expect(await transcribeRecording({ engine: 'vosk' }, btoa('x'), async () => silence(2))).toBe('');
    expect(engine.transcribe).not.toHaveBeenCalled();
  });
});
