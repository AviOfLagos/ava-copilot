/**
 * Lets microphone audio through only while someone is speaking. A live voice model bills every second
 * of audio it is sent, so silence stays on the device. Speech is judged by loudness against a noise
 * floor that follows the room; a little audio from just before speech starts is kept so the first word
 * is not cut, and the gate stays open briefly after speech so pauses between words pass too.
 *
 * While the copilot's own voice is playing, the microphone hears it too (echo cancellation removes most
 * of it, not all, and a chosen speaker can sit right next to the mic). So during playback the gate asks
 * for more: a louder level, held for a moment, before it opens. Talking over the copilot still works;
 * its echo does not count as the user.
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
  // While the copilot is audible: the quietest level that can be the user talking over it
  playbackLevel?: number;
  // While the copilot is audible: how long that level must last before the gate opens
  playbackHoldMs?: number;
  // How far back the quietest moment is looked for, so a room that got louder for good becomes the new floor
  floorWindowMs?: number;
}

export interface PushOptions {
  // The copilot's voice is playing now
  playing?: boolean;
}

/** Loudness of a chunk: root mean square of its samples. */
export function level(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

// Shorter than the server's own end-of-speech silence, so it is the server that decides when a turn ended
export const GATE_HANGOVER_MS = 700;

export class SpeechGate {
  private readonly prerollSamples: number;
  private readonly hangoverSamples: number;
  private readonly minLevel: number;
  private readonly ratio: number;
  private readonly playbackLevel: number;
  private readonly playbackHoldSamples: number;
  private readonly floorWindowSamples: number;
  private noiseFloor = 0.005;
  private preroll: Float32Array[] = [];
  private prerollSize = 0;
  private open = false;
  private sinceLoud = 0;
  // Loud audio in a row while the copilot speaks, toward playbackHoldMs
  private loudDuringPlayback = 0;
  // Recent chunk levels, for the quietest moment of the last floorWindowMs
  private recent: { level: number; size: number }[] = [];
  private recentSize = 0;

  constructor(options: SpeechGateOptions) {
    const samples = (ms: number) => Math.round((ms / 1000) * options.sampleRate);
    this.prerollSamples = samples(options.prerollMs ?? 300);
    this.hangoverSamples = samples(options.hangoverMs ?? GATE_HANGOVER_MS);
    this.minLevel = options.minLevel ?? 0.012;
    this.ratio = options.ratio ?? 3;
    this.playbackLevel = options.playbackLevel ?? 0.04;
    this.playbackHoldSamples = samples(options.playbackHoldMs ?? 300);
    this.floorWindowSamples = samples(options.floorWindowMs ?? 3000);
  }

  /** Whether the gate is letting audio through. */
  get speaking(): boolean {
    return this.open;
  }

  /** The level speech must pass now: the copilot's voice playing raises it. */
  threshold(playing = false): number {
    const base = Math.max(this.minLevel, this.noiseFloor * this.ratio);
    return playing ? Math.max(base, this.playbackLevel) : base;
  }

  /** Opens the gate at once, e.g. for audio already known to be speech (what followed "Hey Ava"). */
  force(): void {
    this.open = true;
    this.sinceLoud = 0;
    this.preroll = [];
    this.prerollSize = 0;
  }

  /** Closes the gate without reporting an end and forgets the lead-in (the microphone was held). */
  reset(): void {
    this.open = false;
    this.sinceLoud = 0;
    this.loudDuringPlayback = 0;
    this.preroll = [];
    this.prerollSize = 0;
  }

  push(samples: Float32Array, { playing = false }: PushOptions = {}): GateResult {
    const loudness = level(samples);
    const loud = loudness > this.threshold(playing);
    this.followFloor(loudness, samples.length);

    if (this.open) {
      this.sinceLoud = loud ? 0 : this.sinceLoud + samples.length;
      if (this.sinceLoud > this.hangoverSamples) {
        this.open = false;
        this.loudDuringPlayback = 0;
        this.keep(samples);
        return { send: [], ended: true };
      }
      return { send: [samples], ended: false };
    }

    // Over the copilot's voice only speech that lasts opens the gate: a burst of echo does not
    if (loud && playing) {
      this.loudDuringPlayback += samples.length;
      if (this.loudDuringPlayback < this.playbackHoldSamples) {
        this.keep(samples);
        return { send: [], ended: false };
      }
    } else {
      this.loudDuringPlayback = 0;
    }

    if (loud) {
      this.open = true;
      this.sinceLoud = 0;
      this.loudDuringPlayback = 0;
      const send = [...this.preroll, samples];
      this.preroll = [];
      this.prerollSize = 0;
      return { send, ended: false };
    }
    this.keep(samples);
    return { send: [], ended: false };
  }

  /**
   * The floor follows quiet sound, so a steady fan never counts as speech. When the room gets louder for good
   * (nothing quieter than the threshold for the whole window), the quietest of that window pulls the floor up,
   * so a raised hum cannot hold the gate open forever. Speech has gaps, so its quietest moment stays low.
   */
  private followFloor(loudness: number, size: number): void {
    if (loudness <= this.threshold(false)) this.noiseFloor = this.noiseFloor * 0.95 + loudness * 0.05;
    this.recent.push({ level: loudness, size });
    this.recentSize += size;
    while (this.recent.length > 1 && this.recentSize - this.recent[0].size >= this.floorWindowSamples) {
      this.recentSize -= this.recent.shift()!.size;
    }
    if (this.recentSize < this.floorWindowSamples) return;
    let quietest = Infinity;
    for (const entry of this.recent) quietest = Math.min(quietest, entry.level);
    if (quietest > this.threshold(false)) this.noiseFloor = this.noiseFloor * 0.8 + quietest * 0.2;
  }

  private keep(samples: Float32Array): void {
    this.preroll.push(samples);
    this.prerollSize += samples.length;
    while (this.preroll.length > 1 && this.prerollSize - this.preroll[0].length >= this.prerollSamples) {
      this.prerollSize -= this.preroll.shift()!.length;
    }
  }
}
