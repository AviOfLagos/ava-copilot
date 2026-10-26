import { oggOpus } from './ogg';
import type { OpusPacket } from './ogg';

/**
 * Ava's spoken answer made into a WhatsApp voice note, in the offscreen document: the WAV a voice rendered becomes
 * mono Opus through WebCodecs' AudioEncoder (there is no ffmpeg on the Mac), wrapped in Ogg by ./ogg. The bars
 * WhatsApp draws in the bubble come from the same samples.
 */

// Opus runs at 48 kHz inside, and Chrome gives its look-ahead in the encoder's own rate where Ogg wants 48 kHz, so
// speech is always brought to 48 kHz first: the pre-skip is then right however it is read
const OPUS_RATE = 48000;
// Speech at this rate sounds clean and stays small (a minute is about 240 KB)
const BITRATE = 32_000;
// The encoder's look-ahead when it does not say: libopus's 6.5 ms at 48 kHz
const DEFAULT_PRE_SKIP = 312;
// Fed to the encoder in pieces of this many samples
const CHUNK = 4800;
export const WAVEFORM_BARS = 64;

export interface VoiceNote {
  ogg: Uint8Array;
  seconds: number;
  // Loudness 0-100 for each bar
  waveform: number[];
}

/** What the encoder needs from WebCodecs, so tests can stand in for it. */
export interface CodecApi {
  AudioEncoder: typeof AudioEncoder;
  AudioData: typeof AudioData;
}

/** Mono float samples of a PCM WAV file (8, 16, 24 or 32-bit integer, or 32-bit float; channels mixed). */
export function decodeWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE')
    throw new Error('The voice did not make a WAV file.');
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      if (!channels || !sampleRate) break;
      const width = bits / 8;
      const end = Math.min(bytes.length, body + size);
      const frames = Math.floor((end - body) / (width * channels));
      const samples = new Float32Array(frames);
      const read = (at: number): number => {
        if (format === 3 && bits === 32) return view.getFloat32(at, true);
        if (bits === 8) return (view.getUint8(at) - 128) / 128;
        if (bits === 16) return view.getInt16(at, true) / 0x8000;
        if (bits === 24)
          return (
            ((view.getUint8(at + 2) << 24) | (view.getUint8(at + 1) << 16) | (view.getUint8(at) << 8)) / 0x80000000
          );
        if (bits === 32) return view.getInt32(at, true) / 0x80000000;
        throw new Error('The voice made a WAV file Ava cannot read.');
      };
      for (let frame = 0; frame < frames; frame++) {
        let sum = 0;
        for (let channel = 0; channel < channels; channel++) sum += read(body + (frame * channels + channel) * width);
        samples[frame] = sum / channels;
      }
      return { samples, sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('The voice made a WAV file with no sound in it.');
}

/** Linear resampling: plenty for speech going to a voice note. */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const out = new Float32Array(Math.max(1, Math.round((samples.length * to) / from)));
  const step = from / to;
  for (let i = 0; i < out.length; i++) {
    const at = i * step;
    const left = Math.floor(at);
    const right = Math.min(samples.length - 1, left + 1);
    out[i] = samples[left] + (samples[right] - samples[left]) * (at - left);
  }
  return out;
}

/** WhatsApp's bars: the loudness of each stretch of the note, the loudest at 100. */
export function waveformOf(samples: Float32Array, bars = WAVEFORM_BARS): number[] {
  const levels = Array.from({ length: bars }, (_, bar) => {
    const start = Math.floor((bar * samples.length) / bars);
    const end = Math.max(start + 1, Math.floor(((bar + 1) * samples.length) / bars));
    let sum = 0;
    for (let i = start; i < end && i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / (end - start));
  });
  const loudest = Math.max(...levels);
  return levels.map(level => (loudest > 0 ? Math.round((level / loudest) * 100) : 0));
}

/** The pre-skip the encoder put in its Opus header, when it gave one. */
function preSkipOf(description: AllowSharedBufferSource | undefined): number | null {
  if (!description) return null;
  const bytes = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description as ArrayBuffer);
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 8)) !== 'OpusHead') return null;
  return bytes[10] | (bytes[11] << 8);
}

/** Mono samples as an Ogg/Opus voice note, with its length and bars. */
export async function encodeVoiceNote(
  input: Float32Array,
  inputRate: number,
  api: CodecApi = globalThis as unknown as CodecApi,
): Promise<VoiceNote> {
  if (!input.length) throw new Error('The voice made no sound.');
  if (typeof api.AudioEncoder !== 'function') throw new Error('This browser cannot make voice notes.');
  const sampleRate = OPUS_RATE;
  const samples = resample(input, inputRate, sampleRate);
  const config: AudioEncoderConfig = { codec: 'opus', sampleRate, numberOfChannels: 1, bitrate: BITRATE };
  const support = await api.AudioEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error('This browser cannot make Opus audio.');

  const packets: OpusPacket[] = [];
  let preSkip: number | null = null;
  let failure = null as Error | null;
  const encoder = new api.AudioEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      // A 20 ms frame unless the chunk says otherwise
      const samples48 = chunk.duration ? Math.round((chunk.duration * 48) / 1000) : 960;
      packets.push({ data, samples: samples48 });
      preSkip ??= preSkipOf(metadata?.decoderConfig?.description);
    },
    error: error => {
      failure = error instanceof Error ? error : new Error(String(error));
    },
  });
  encoder.configure(config);
  try {
    for (let start = 0; start < samples.length; start += CHUNK) {
      const piece = samples.slice(start, start + CHUNK);
      const data = new api.AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: piece.length,
        numberOfChannels: 1,
        timestamp: Math.round((start / sampleRate) * 1_000_000),
        data: piece,
      });
      encoder.encode(data);
      data.close();
    }
    await encoder.flush();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (failure) throw failure;
  if (!packets.length) throw new Error('The encoder made no audio.');
  const length = samples.length;
  return {
    ogg: oggOpus({ packets, inputSampleRate: inputRate, channels: 1, preSkip: preSkip ?? DEFAULT_PRE_SKIP, length }),
    seconds: Math.max(1, Math.round(input.length / inputRate)),
    waveform: waveformOf(input),
  };
}
