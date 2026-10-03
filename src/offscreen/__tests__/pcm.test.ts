import { describe, expect, it } from 'vitest';
import { ChunkCutter, encodeWav, rms, toBase64 } from '../pcm';

// Ten samples a second keeps the arithmetic readable; each sample holds its own index
const plan = { sampleRate: 10, firstChunkSeconds: 2, chunkSeconds: 4, overlapSeconds: 1 };
const ramp = (from: number, count: number) => Float32Array.from({ length: count }, (_, i) => from + i);

describe('ChunkCutter', () => {
  it('cuts a short first chunk, then longer ones that repeat the last second', () => {
    const cutter = new ChunkCutter(plan);
    const chunks = cutter.push(ramp(0, 100));
    expect(chunks.map(c => [c.index, c.tStart, c.tEnd])).toEqual([
      [0, 0, 2],
      [1, 1, 5],
      [2, 4, 8],
    ]);
    expect(chunks[1].samples[0]).toBe(10);
    expect(chunks[1].samples.length).toBe(40);
    expect(chunks[2].samples[0]).toBe(40);
  });

  it('gives the same chunks whatever size the incoming blocks are', () => {
    const whole = new ChunkCutter(plan).push(ramp(0, 90));
    const pieces = new ChunkCutter(plan);
    const fromPieces = [];
    for (let i = 0; i < 90; i += 7) fromPieces.push(...pieces.push(ramp(i, Math.min(7, 90 - i))));
    expect(fromPieces.map(c => [c.tStart, c.tEnd, Array.from(c.samples)])).toEqual(
      whole.map(c => [c.tStart, c.tEnd, Array.from(c.samples)]),
    );
  });

  it('hands out the rest at the end, starting with the overlap', () => {
    const cutter = new ChunkCutter(plan);
    cutter.push(ramp(0, 63));
    const last = cutter.flush();
    expect([last?.tStart, last?.tEnd]).toEqual([4, 6.3]);
    expect(last?.samples[0]).toBe(40);
    expect(cutter.flush()).toBeNull();
  });

  it('hands out a recording shorter than the first chunk', () => {
    const cutter = new ChunkCutter(plan);
    expect(cutter.push(ramp(0, 5))).toEqual([]);
    expect(cutter.flush()?.samples.length).toBe(5);
  });

  it('hands out nothing for an empty recording', () => {
    expect(new ChunkCutter(plan).flush()).toBeNull();
  });
});

describe('rms', () => {
  it('measures loudness', () => {
    expect(rms(new Float32Array(10))).toBe(0);
    expect(rms(Float32Array.from([1, -1, 1, -1]))).toBe(1);
    expect(rms(new Float32Array(0))).toBe(0);
  });
});

describe('encodeWav', () => {
  it('writes a 16 kHz mono 16-bit WAV header and samples', () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1, 0.5]), 16000);
    const view = new DataView(wav.buffer);
    const ascii = (from: number, to: number) => String.fromCharCode(...wav.slice(from, to));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 12)).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([0, 32767, -32768]);
    expect(wav.length).toBe(52);
  });

  it('clips samples outside -1..1', () => {
    const view = new DataView(encodeWav(Float32Array.from([3, -3]), 8000).buffer);
    expect([view.getInt16(44, true), view.getInt16(46, true)]).toEqual([32767, -32768]);
  });
});

describe('toBase64', () => {
  it('encodes large byte arrays', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    const decoded = Uint8Array.from(atob(toBase64(bytes)), c => c.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });
});
