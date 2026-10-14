import { describe, expect, it } from 'vitest';
import { bytesToBase64, encodeWav, hasSound, toMono } from '../wav';

describe('video sound for the speech model', () => {
  it('writes 16-bit mono WAV with the right header', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 0.5]), 16_000);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe('WAVE');
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map(i => view.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 16383]);
  });

  it('mixes channels and tells silence from sound', () => {
    expect(Array.from(toMono([new Float32Array([1, 0]), new Float32Array([0, 1])]))).toEqual([0.5, 0.5]);
    expect(hasSound(new Float32Array(100))).toBe(false);
    expect(hasSound(new Float32Array([0, 0.2]))).toBe(true);
  });

  it('encodes bytes as base64', () => {
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
  });
});
