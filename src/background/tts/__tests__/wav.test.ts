import { describe, expect, it } from 'vitest';
import { pcmToWavDataUrl, wavHeader } from '../wav';

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

describe('wavHeader', () => {
  it('writes a canonical 44-byte PCM header', () => {
    const header = wavHeader(1000, 24_000, 1);
    expect(header.length).toBe(44);
    expect(ascii(header, 0, 4)).toBe('RIFF');
    expect(ascii(header, 8, 4)).toBe('WAVE');
    expect(ascii(header, 12, 4)).toBe('fmt ');
    expect(ascii(header, 36, 4)).toBe('data');

    const view = new DataView(header.buffer);
    expect(view.getUint32(4, true)).toBe(36 + 1000); // RIFF chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24_000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(1000); // data chunk size
  });
});

describe('pcmToWavDataUrl', () => {
  it('wraps the PCM bytes unchanged behind a playable data URL', () => {
    const pcmBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const base64Pcm = btoa(String.fromCharCode(...pcmBytes));

    const dataUrl = pcmToWavDataUrl(base64Pcm, 24_000, 1);
    expect(dataUrl.startsWith('data:audio/wav;base64,')).toBe(true);

    const wavBase64 = dataUrl.slice('data:audio/wav;base64,'.length);
    const wavBytes = Uint8Array.from(atob(wavBase64), char => char.charCodeAt(0));
    expect(wavBytes.length).toBe(44 + pcmBytes.length);
    expect([...wavBytes.slice(44)]).toEqual([...pcmBytes]);
  });
});
