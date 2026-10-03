/**
 * Cutting recorded audio into overlapping chunks and writing them as WAV files.
 * Raw 16 kHz mono PCM is what the transcriber gets: every model that takes audio accepts WAV,
 * and cutting samples, unlike a compressed stream, gives chunks that each stand alone.
 */

export interface ChunkPlan {
  sampleRate: number;
  // The first chunk is short, so the first words show within seconds
  firstChunkSeconds: number;
  chunkSeconds: number;
  // Each chunk repeats the end of the previous one, so no word is cut in half at a boundary
  overlapSeconds: number;
}

export interface PcmChunk {
  index: number;
  // Seconds from the start of the recording
  tStart: number;
  tEnd: number;
  samples: Float32Array;
}

/**
 * Collects samples and hands out chunks as they fill up.
 */
export class ChunkCutter {
  private buffer = new Float32Array(0);
  // The absolute sample index of buffer[0]
  private bufferStart = 0;
  private chunkStart = 0;
  private index = 0;

  constructor(private readonly plan: ChunkPlan) {}

  private lengthOf(index: number): number {
    const seconds = index === 0 ? this.plan.firstChunkSeconds : this.plan.chunkSeconds;
    return Math.round(seconds * this.plan.sampleRate);
  }

  private get overlap(): number {
    return Math.round(this.plan.overlapSeconds * this.plan.sampleRate);
  }

  /** Total samples received so far. */
  get received(): number {
    return this.bufferStart + this.buffer.length;
  }

  /**
   * Adds samples and returns the chunks they complete.
   */
  push(samples: Float32Array): PcmChunk[] {
    const joined = new Float32Array(this.buffer.length + samples.length);
    joined.set(this.buffer);
    joined.set(samples, this.buffer.length);
    this.buffer = joined;

    const chunks: PcmChunk[] = [];
    while (this.received >= this.chunkStart + this.lengthOf(this.index)) {
      chunks.push(this.cut(this.lengthOf(this.index)));
    }
    return chunks;
  }

  /**
   * Hands out what is left at the end of a recording, starting with the overlap the last chunk
   * left for its successor: the transcript of that chunk stops short of it. Returns null when
   * nothing is left.
   */
  flush(): PcmChunk | null {
    const length = this.received - this.chunkStart;
    if (length <= 0) {
      return null;
    }
    const chunk = this.cut(length);
    // The recording is over: nothing carries into another chunk
    this.chunkStart = this.received;
    this.bufferStart = this.received;
    this.buffer = new Float32Array(0);
    return chunk;
  }

  private cut(length: number): PcmChunk {
    const from = this.chunkStart - this.bufferStart;
    const chunk: PcmChunk = {
      index: this.index,
      tStart: this.chunkStart / this.plan.sampleRate,
      tEnd: (this.chunkStart + length) / this.plan.sampleRate,
      samples: this.buffer.slice(from, from + length),
    };
    this.index++;
    // The next chunk starts one overlap before this one ended
    this.chunkStart = Math.max(this.chunkStart + length - this.overlap, this.chunkStart + 1);
    const drop = this.chunkStart - this.bufferStart;
    this.buffer = this.buffer.slice(drop);
    this.bufferStart = this.chunkStart;
    return chunk;
  }
}

/**
 * The loudness of a block of samples, 0 to 1.
 */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Writes mono float samples as a 16-bit PCM WAV file.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // format chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return bytes;
}

/**
 * Base64 of bytes, in pieces so large chunks do not overflow the call stack.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}
