import { describe, expect, it } from 'vitest';
import { AudioRing, heardWake, heyAvaPrefix } from '../wake';

describe('heardWake', () => {
  it('hears the phrase, alone or with a request after it', () => {
    expect(heardWake('hey ava')).toBe(true);
    expect(heardWake('[unk] hey ava [unk]')).toBe(true);
    expect(heardWake('[unk]')).toBe(false);
    expect(heardWake('')).toBe(false);
    expect(heardWake(undefined)).toBe(false);
  });
});

describe('heyAvaPrefix', () => {
  it('accepts a VERIFY_GRAMMAR transcript that starts with "hey ava"', () => {
    expect(heyAvaPrefix('hey ava')).toBe(true);
    // The verified window can run a little past "ava" into the next word, which the verifier's
    // own grammar then tags as trailing "[unk]" tokens (seen on "Hey Ava, what's on my calendar").
    expect(heyAvaPrefix('hey ava [unk]')).toBe(true);
    expect(heyAvaPrefix('hey ava [unk] [unk]')).toBe(true);
    expect(heyAvaPrefix('HEY AVA')).toBe(true);
    expect(heyAvaPrefix('  hey   ava  ')).toBe(true);
  });

  it('rejects everything a "hey"-only or unrelated utterance can decode to in that grammar', () => {
    expect(heyAvaPrefix('hey')).toBe(false);
    expect(heyAvaPrefix('ava')).toBe(false);
    expect(heyAvaPrefix('[unk]')).toBe(false);
    expect(heyAvaPrefix('[unk] hey')).toBe(false);
    expect(heyAvaPrefix('[unk] hey ava')).toBe(false); // "ava" must follow "hey" directly
    expect(heyAvaPrefix('')).toBe(false);
    expect(heyAvaPrefix(undefined)).toBe(false);
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
