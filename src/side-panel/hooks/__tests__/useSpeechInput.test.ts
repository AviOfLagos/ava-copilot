import { describe, expect, it } from 'vitest';
import { meterLevel } from '../useSpeechInput';

describe('meterLevel', () => {
  it('reads silence as nothing and a loud voice as full', () => {
    expect(meterLevel(new Float32Array(512))).toBe(0);
    expect(meterLevel(new Float32Array(512).fill(0.5))).toBe(1);
    expect(meterLevel(new Float32Array(0))).toBe(0);
  });

  it('follows how loud it sounds: ten times the signal is a step up, not ten', () => {
    const quiet = meterLevel(new Float32Array(512).fill(0.005));
    const speech = meterLevel(new Float32Array(512).fill(0.05));
    expect(quiet).toBeGreaterThan(0);
    expect(speech).toBeGreaterThan(quiet);
    expect(speech - quiet).toBeCloseTo(0.4, 5);
  });
});
