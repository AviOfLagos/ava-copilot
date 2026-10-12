/**
 * Lets microphone audio through only while someone is speaking. A live voice model bills every second
 * of audio it is sent, so silence stays on the device. Speech is judged by loudness against a noise
 * floor that follows the room; a little audio from just before speech starts is kept so the first word
 * is not cut, and the gate stays open briefly after speech so pauses between words pass too.
 */

export interface GateResult {
  // Audio to send now, oldest first
  send: Float32Array[];
  // Speech just ended: the model should be told the stream paused
  ended: boolean;
}

export interface SpeechGateOptions {
  sampleRate: number;
  // Audio kept from before speech starts
  prerollMs?: number;
  // How long the gate stays open after the last loud chunk
  hangoverMs?: number;
  // The quietest level that can count as speech, whatever the room
  minLevel?: number;
  // How far above the noise floor speech must be
  ratio?: number;
}

/** Loudness of a chunk: root mean square of its samples. */
export function level(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

export class SpeechGate {
  private readonly prerollSamples: number;
  private readonly hangoverSamples: number;
  private readonly minLevel: number;
  private readonly ratio: number;
  private noiseFloor = 0.005;
  private preroll: Float32Array[] = [];
  private prerollSize = 0;
  private open = false;
  private sinceLoud = 0;

  constructor(options: SpeechGateOptions) {
    this.prerollSamples = Math.round(((options.prerollMs ?? 300) / 1000) * options.sampleRate);
    this.hangoverSamples = Math.round(((options.hangoverMs ?? 900) / 1000) * options.sampleRate);
    this.minLevel = options.minLevel ?? 0.012;
    this.ratio = options.ratio ?? 3;
  }

  /** Whether the gate is letting audio through. */
  get speaking(): boolean {
    return this.open;
  }

  /** Opens the gate at once, e.g. for audio already known to be speech (what followed "Hey Ava"). */
  force(): void {
    this.open = true;
    this.sinceLoud = 0;
    this.preroll = [];
    this.prerollSize = 0;
  }

  push(samples: Float32Array): GateResult {
    const loudness = level(samples);
    const loud = loudness > Math.max(this.minLevel, this.noiseFloor * this.ratio);
    if (!loud) {
      // The floor follows quiet sound slowly, so a steady fan or hum never counts as speech
      this.noiseFloor = this.noiseFloor * 0.95 + loudness * 0.05;
    }

    if (this.open) {
      this.sinceLoud = loud ? 0 : this.sinceLoud + samples.length;
      if (this.sinceLoud > this.hangoverSamples) {
        this.open = false;
        this.keep(samples);
        return { send: [], ended: true };
      }
      return { send: [samples], ended: false };
    }

    if (loud) {
      this.open = true;
      this.sinceLoud = 0;
      const send = [...this.preroll, samples];
      this.preroll = [];
      this.prerollSize = 0;
      return { send, ended: false };
    }
    this.keep(samples);
    return { send: [], ended: false };
  }

  private keep(samples: Float32Array): void {
    this.preroll.push(samples);
    this.prerollSize += samples.length;
    while (this.preroll.length > 1 && this.prerollSize - this.preroll[0].length >= this.prerollSamples) {
      this.prerollSize -= this.preroll.shift()!.length;
    }
  }
}
