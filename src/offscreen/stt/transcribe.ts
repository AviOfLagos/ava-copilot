import type { EconomyEngines } from '../../background/voice/engines/wire';
import { acquireStt, releaseStt } from './pool';
import { isRequest, UtteranceCollector } from './utterances';

/**
 * Writes down a recording on the device: the chat box's dictation when no Gemini speech-to-text is set up. The
 * recording (webm from the panel, or a wav attachment) is decoded to 16 kHz mono, cut into utterances at the pauses
 * (a recogniser takes one utterance at a time, and silence is never transcribed), and each is written down in turn.
 */

const RATE = 16_000;
const CHUNK = 4096;

/** Decodes encoded audio to 16 kHz mono samples. */
export async function decodeToMono(bytes: ArrayBuffer): Promise<Float32Array> {
  const context = new AudioContext({ sampleRate: RATE });
  try {
    const buffer = await context.decodeAudioData(bytes);
    const mono = new Float32Array(buffer.length);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
    }
    return mono;
  } finally {
    void context.close().catch(() => {});
  }
}

/** The utterances in a recording, in order: the parts with speech, cut at pauses and at most 25 s each. */
export function splitUtterances(samples: Float32Array): Float32Array[] {
  const collector = new UtteranceCollector({ sampleRate: RATE, maxMs: 25_000 });
  const out: Float32Array[] = [];
  const take = (chunk: Float32Array) => {
    const { utterance } = collector.push(chunk);
    if (utterance) out.push(utterance);
  };
  for (let start = 0; start < samples.length; start += CHUNK) take(samples.subarray(start, start + CHUNK));
  // A recording that stops mid-word still ends its last utterance
  for (let i = 0; i < 6 && collector.speaking; i++) take(new Float32Array(CHUNK));
  return out;
}

export async function transcribeRecording(
  config: EconomyEngines['stt'],
  base64: string,
  decode: (bytes: ArrayBuffer) => Promise<Float32Array> = decodeToMono,
): Promise<string> {
  const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  const samples = await decode(bytes.buffer);
  const parts = splitUtterances(samples);
  if (!parts.length) return '';
  const engine = await acquireStt(config);
  try {
    const words: string[] = [];
    for (const part of parts) {
      const text = (await engine.transcribe(part, config.language)).trim();
      if (isRequest(text)) words.push(text);
    }
    return words.join(' ');
  } finally {
    releaseStt();
  }
}
