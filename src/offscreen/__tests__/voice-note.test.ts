import { describe, expect, it } from 'vitest';
import { decodeWav, encodeVoiceNote, resample, waveformOf } from '../voice-note/encode';
import type { CodecApi } from '../voice-note/encode';
import { oggCrc, oggOpus, oggPage, opusHead } from '../voice-note/ogg';
import { encodeWav } from '../pcm';

/** The pages of an Ogg file: header type, granule, sequence, its packets, and whether its CRC holds. */
function pagesOf(file: Uint8Array) {
  const pages = [];
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  for (let offset = 0; offset < file.length;) {
    expect(String.fromCharCode(...file.subarray(offset, offset + 4))).toBe('OggS');
    const segments = file[offset + 26];
    const lacing = [...file.subarray(offset + 27, offset + 27 + segments)];
    const length = 27 + segments + lacing.reduce((sum, value) => sum + value, 0);
    const page = file.slice(offset, offset + length);
    const crc = view.getUint32(offset + 22, true);
    new DataView(page.buffer).setUint32(22, 0, true);
    const packets: Uint8Array[] = [];
    let at = 27 + segments;
    let size = 0;
    for (const value of lacing) {
      size += value;
      if (value < 255) {
        packets.push(page.subarray(at, at + size));
        at += size;
        size = 0;
      }
    }
    pages.push({
      type: file[offset + 5],
      granule: Number(view.getBigInt64(offset + 6, true)),
      sequence: view.getUint32(offset + 18, true),
      packets,
      crcHolds: oggCrc(page) === crc,
    });
    offset += length;
  }
  return pages;
}

describe('the Ogg muxer', () => {
  it('uses Ogg’s CRC-32', () => {
    // Polynomial 0x04c11db7, starting at 0, no final xor: the check value for "123456789"
    expect(oggCrc(new TextEncoder().encode('123456789'))).toBe(0x89a1897f);
  });

  it('laces a packet of 255 bytes or more over several segments', () => {
    const page = oggPage([new Uint8Array(255), new Uint8Array(3)], { granule: 0, serial: 1, sequence: 0, type: 0 });
    expect([...page.subarray(26, 30)]).toEqual([3, 255, 0, 3]);
  });

  it('puts the Opus headers first, then the audio, the last page marked and trimmed', () => {
    const packets = Array.from({ length: 120 }, (_, i) => ({ data: new Uint8Array([i, i]), samples: 960 }));
    const file = oggOpus({ packets, inputSampleRate: 24000, channels: 1, preSkip: 312, length: 114_000 });
    const pages = pagesOf(file);
    expect(pages.every(page => page.crcHolds)).toBe(true);
    expect(pages.map(page => page.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(pages[0].type).toBe(2);
    expect([...pages[0].packets[0]]).toEqual([...opusHead(1, 312, 24000)]);
    expect(String.fromCharCode(...pages[1].packets[0].subarray(0, 8))).toBe('OpusTags');
    expect(pages.slice(2).map(page => page.packets.length)).toEqual([50, 50, 20]);
    expect(pages.slice(2).map(page => page.granule)).toEqual([48_000, 96_000, 114_312]);
    expect(pages.at(-1)!.type).toBe(4);
  });

  it('writes the identification header RFC 7845 describes', () => {
    const head = opusHead(1, 312, 24000);
    const view = new DataView(head.buffer);
    expect(String.fromCharCode(...head.subarray(0, 8))).toBe('OpusHead');
    expect([head[8], head[9], view.getUint16(10, true), view.getUint32(12, true), head[18]]).toEqual([
      1, 1, 312, 24000, 0,
    ]);
  });
});

describe('the voice note encoder', () => {
  it('reads the WAV a voice renders', () => {
    const samples = Float32Array.from({ length: 2400 }, (_, i) => Math.sin(i / 10) * 0.5);
    const decoded = decodeWav(encodeWav(samples, 24000));
    expect(decoded.sampleRate).toBe(24000);
    expect(decoded.samples).toHaveLength(2400);
    expect(Math.abs(decoded.samples[100] - samples[100])).toBeLessThan(1e-4);
    expect(() => decodeWav(new Uint8Array(40))).toThrow(/WAV/);
  });

  it('resamples and draws the bubble’s bars, the loudest at 100', () => {
    expect(resample(new Float32Array(441), 44100, 48000)).toHaveLength(480);
    const quietThenLoud = Float32Array.from({ length: 6400 }, (_, i) => (i < 3200 ? 0.1 : 0.8));
    const bars = waveformOf(quietThenLoud);
    expect(bars).toHaveLength(64);
    expect(bars[0]).toBe(13);
    expect(bars[63]).toBe(100);
  });

  it('makes Ogg/Opus from what WebCodecs encodes, with the encoder’s own pre-skip', async () => {
    const configured: AudioEncoderConfig[] = [];
    class FakeEncoder {
      state = 'unconfigured';
      constructor(private readonly init: AudioEncoderInit) {}
      static async isConfigSupported(config: AudioEncoderConfig) {
        return { supported: config.codec === 'opus', config };
      }
      configure(config: AudioEncoderConfig) {
        configured.push(config);
        this.state = 'configured';
      }
      // One 20 ms packet per 20 ms of input
      encode(data: { numberOfFrames: number; sampleRate: number }) {
        const frames = Math.ceil(data.numberOfFrames / (data.sampleRate / 50));
        for (let i = 0; i < frames; i++) {
          const head = opusHead(1, 120, 48000);
          this.init.output(
            { byteLength: 4, duration: 20_000, copyTo: (target: Uint8Array) => target.set([1, 2, 3, 4]) } as never,
            { decoderConfig: { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, description: head } } as never,
          );
        }
      }
      async flush() {}
      close() {
        this.state = 'closed';
      }
    }
    class FakeAudioData {
      numberOfFrames: number;
      sampleRate: number;
      constructor(init: { numberOfFrames: number; sampleRate: number }) {
        this.numberOfFrames = init.numberOfFrames;
        this.sampleRate = init.sampleRate;
      }
      close() {}
    }
    const api = { AudioEncoder: FakeEncoder, AudioData: FakeAudioData } as unknown as CodecApi;
    const second = Float32Array.from({ length: 24000 }, (_, i) => Math.sin(i / 5) * 0.3);
    const note = await encodeVoiceNote(second, 24000, api);
    expect(configured).toEqual([{ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 32000 }]);
    expect(note.seconds).toBe(1);
    expect(note.waveform).toHaveLength(64);
    const pages = pagesOf(note.ogg);
    expect(new DataView(pages[0].packets[0].buffer, pages[0].packets[0].byteOffset).getUint16(10, true)).toBe(120);
    // The 24 kHz input is header information only
    expect(new DataView(pages[0].packets[0].buffer, pages[0].packets[0].byteOffset).getUint32(12, true)).toBe(24000);
    expect(pages.slice(2).reduce((sum, page) => sum + page.packets.length, 0)).toBe(50);
    expect(pages.at(-1)!.granule).toBe(48_000);
  });

  it('encodes at 48 kHz whatever rate the voice used', async () => {
    const rates: number[] = [];
    const api = {
      AudioEncoder: class {
        state = 'configured';
        constructor(private readonly init: AudioEncoderInit) {}
        static async isConfigSupported() {
          return { supported: true };
        }
        configure(config: AudioEncoderConfig) {
          rates.push(config.sampleRate);
        }
        encode() {
          this.init.output({ byteLength: 1, duration: 20_000, copyTo: () => {} } as never, undefined as never);
        }
        async flush() {}
        close() {}
      },
      AudioData: class {
        close() {}
      },
    } as unknown as CodecApi;
    await encodeVoiceNote(new Float32Array(22050), 22050, api);
    expect(rates).toEqual([48000]);
  });
});
