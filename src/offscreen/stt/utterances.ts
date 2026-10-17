import { SpeechGate } from '../vad';
import type { PushOptions } from '../vad';

/**
 * Cuts the microphone into utterances for a local recogniser: the speech gate decides when someone speaks, and
 * the audio from its opening to its closing (with the lead-in it keeps) is one utterance. Silence is never
 * transcribed, and the gate closing is the end of the user's turn.
 */

export interface UtteranceOptions {
  sampleRate?: number;
  // Less voiced sound than this is a click or a knock, not words (the lead-in and pause around it never count)
  minVoicedMs?: number;
  // A longer stretch of speech is cut here and transcribed, then collecting goes on
  maxMs?: number;
  // Quiet after speech that ends the turn
  hangoverMs?: number;
}

export interface UtteranceStep {
  // The gate opened on this chunk: someone started talking
  speechStarted: boolean;
  // A finished utterance, 16 kHz mono
  utterance: Float32Array | null;
}

export function concat(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// Voiced sound is counted in frames of this length, loud enough to be speech
const FRAME_MS = 20;
const VOICED_LEVEL = 0.012;

/** How many samples of a chunk are in frames loud enough to be voiced sound. */
export function voicedSamples(samples: Float32Array, frame: number): number {
  let voiced = 0;
  for (let start = 0; start < samples.length; start += frame) {
    const part = samples.subarray(start, Math.min(samples.length, start + frame));
    let sum = 0;
    for (const sample of part) sum += sample * sample;
    if (Math.sqrt(sum / part.length) > VOICED_LEVEL) voiced += part.length;
  }
  return voiced;
}

export class UtteranceCollector {
  private readonly gate: SpeechGate;
  private readonly minVoiced: number;
  private readonly maxSamples: number;
  private readonly frame: number;
  private parts: Float32Array[] = [];
  private size = 0;
  private voiced = 0;

  constructor(options: UtteranceOptions = {}) {
    const sampleRate = options.sampleRate ?? 16_000;
    this.gate = new SpeechGate({ sampleRate, hangoverMs: options.hangoverMs ?? 700 });
    this.minVoiced = Math.round(((options.minVoicedMs ?? 150) / 1000) * sampleRate);
    this.maxSamples = Math.round(((options.maxMs ?? 25_000) / 1000) * sampleRate);
    this.frame = Math.round((FRAME_MS / 1000) * sampleRate);
  }

  /** The level speech must pass now (higher while the copilot's voice plays). */
  threshold(playing = false): number {
    return this.gate.threshold(playing);
  }

  /** Whether someone is speaking right now. */
  get speaking(): boolean {
    return this.gate.speaking;
  }

  /** `playing`: the copilot's voice is playing, so its echo must not be taken for speech (see SpeechGate). */
  push(samples: Float32Array, options: PushOptions = {}): UtteranceStep {
    const wasSpeaking = this.gate.speaking;
    const { send, ended } = this.gate.push(samples, options);
    const speechStarted = !wasSpeaking && this.gate.speaking;
    for (const chunk of send) this.add(chunk);
    if (ended || this.size >= this.maxSamples) return { speechStarted, utterance: this.take() };
    return { speechStarted, utterance: null };
  }

  /** Audio already known to be speech (what followed "Hey Ava"): it starts the utterance, with the gate open. */
  seed(chunks: Float32Array[]): void {
    if (!chunks.length) return;
    this.gate.force();
    for (const chunk of chunks) this.add(chunk);
  }

  /** Drops whatever was being collected and closes the gate, without an utterance (the microphone was held). */
  cancel(): void {
    this.gate.reset();
    this.reset();
  }

  /** Drops whatever was being collected. */
  reset(): void {
    this.parts = [];
    this.size = 0;
    this.voiced = 0;
  }

  private add(chunk: Float32Array): void {
    this.parts.push(chunk);
    this.size += chunk.length;
    this.voiced += voicedSamples(chunk, this.frame);
  }

  private take(): Float32Array | null {
    const parts = this.parts;
    const voiced = this.voiced;
    this.reset();
    return voiced >= this.minVoiced ? concat(parts) : null;
  }
}

/** Whether a recogniser's text has words in it: recognisers turn noise into "" or a lone "." or "[unk]". */
export function hasWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text.replace(/\[unk\]/gi, ''));
}

// What speech recognisers commonly make of noise, breathing or a cough: never something the user asked
// Only junk, so a short real answer ("yeah", "okay", "bye") always gets through
const NOISE_PHRASES = new Set([
  'you',
  'thank you',
  'thanks for watching',
  'thank you for watching',
  'uh',
  'um',
  'hmm',
  'mm',
  'ah',
  'huh',
  'the',
  'i',
]);

const plainWords = (text: string) =>
  text
    .toLowerCase()
    .replace(/\[unk\]/g, ' ')
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Whether a transcript is something said to the copilot, not noise turned into a filler word. */
export function isRequest(text: string): boolean {
  const words = plainWords(text);
  return hasWords(words) && !NOISE_PHRASES.has(words);
}
