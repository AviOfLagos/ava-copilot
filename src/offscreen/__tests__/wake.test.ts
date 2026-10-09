import { describe, expect, it } from 'vitest';
import { AudioRing, heardWake } from '../wake';

describe('heardWake', () => {
  it('hears the phrase, alone or with a request after it', () => {
    expect(heardWake('hey ava')).toBe(true);
    expect(heardWake('[unk] hey ava [unk]')).toBe(true);
    expect(heardWake('[unk]')).toBe(false);
    expect(heardWake('')).toBe(false);
    expect(heardWake(undefined)).toBe(false);
  });
});

describe('AudioRing', () => {
  it('keeps only the last seconds, in order, and empties when taken', () => {
    const ring = new AudioRing(4);
    for (const value of [1, 2, 3]) ring.push(new Float32Array([value, value]));
    expect(ring.take().map(chunk => chunk[0])).toEqual([2, 3]);
    expect(ring.take()).toEqual([]);
  });
});
