import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';
import type { LocalSttEngineId, LocalTtsEngineId } from './voiceEngineSettings';

/**
 * How fast the voices really are on this computer, and a content-free trace of what they did. Code decides from
 * these numbers (no model is asked): a local voice that makes speech slower than it plays leaves a pause after
 * every sentence, so Ava uses the computer's own voice instead and says so (Settings › Voice engines).
 */

/** Seconds of speech made per second of work: 1 keeps up with itself, 2 is twice as fast as it plays. */
export type Speed = number;

// At or above this a voice keeps ahead of its own playback with a short head start; below it a listener hears a
// pause after sentences
export const TTS_STEADY_SPEED: Speed = 1.2;
// Below this even a long head start cannot cover the whole answer: the voice is not worth using on this computer
export const TTS_TOO_SLOW_SPEED: Speed = 0.9;
// Comfortably fast: room for a busy computer
export const TTS_FAST_SPEED: Speed = 2;
// A recogniser that listens slower than speech is said falls behind a conversation
export const STT_STEADY_SPEED: Speed = 1.5;

export type SpeedVerdict = 'unknown' | 'fast' | 'steady' | 'borderline' | 'too-slow';

export function ttsVerdict(speed: Speed | null | undefined): SpeedVerdict {
  if (speed === null || speed === undefined || !Number.isFinite(speed) || speed <= 0) return 'unknown';
  if (speed >= TTS_FAST_SPEED) return 'fast';
  if (speed >= TTS_STEADY_SPEED) return 'steady';
  if (speed >= TTS_TOO_SLOW_SPEED) return 'borderline';
  return 'too-slow';
}

export function sttVerdict(speed: Speed | null | undefined): SpeedVerdict {
  if (speed === null || speed === undefined || !Number.isFinite(speed) || speed <= 0) return 'unknown';
  if (speed >= STT_STEADY_SPEED * 2) return 'fast';
  if (speed >= STT_STEADY_SPEED) return 'steady';
  return speed >= 1 ? 'borderline' : 'too-slow';
}

export interface MeasuredSpeed {
  speed: Speed;
  at: number;
  // A deliberate check of this computer, or what the last real answers showed
  source: 'benchmark' | 'observed';
}

export interface MachineFacts {
  cores: number;
  // navigator.deviceMemory, in gigabytes, capped by the browser at 8; null when it is not reported
  memoryGb: number | null;
  webgpu: boolean;
  // Shared memory, hence several threads for the WebAssembly runtimes, is there; false for extension pages today
  threads: boolean;
}

export interface VoiceHealth {
  tts: Partial<Record<LocalTtsEngineId, MeasuredSpeed>>;
  stt: Partial<Record<LocalSttEngineId, MeasuredSpeed>>;
  machine: MachineFacts | null;
  // When the last deliberate check finished
  checkedAt: number | null;
  // The speech from the last real answers that fell back to the system voice, so Settings can say why
  lastFallback: { at: number; engine: LocalTtsEngineId; speed: Speed } | null;
}

export const EMPTY_VOICE_HEALTH: VoiceHealth = { tts: {}, stt: {}, machine: null, checkedAt: null, lastFallback: null };

/** A new reading mixed with the last one: a single odd answer moves the figure, it does not set it. */
export function blendSpeed(previous: MeasuredSpeed | undefined, speed: Speed, at: number): MeasuredSpeed {
  if (!previous) return { speed, at, source: 'observed' };
  // A fresh deliberate check outweighs one answer; answers pull it gently
  const weight = previous.source === 'benchmark' ? 0.3 : 0.5;
  return { speed: +(previous.speed * (1 - weight) + speed * weight).toFixed(2), at, source: 'observed' };
}

/**
 * Whether a local voice should speak at this length: unknown speed gets the benefit of the doubt, a voice too slow
 * for this computer only speaks one short line (it is over before the slowness shows).
 */
export function localTtsUsable(
  engine: LocalTtsEngineId,
  health: Pick<VoiceHealth, 'tts'>,
  chars = Number.POSITIVE_INFINITY,
  now = Date.now(),
): boolean {
  const reading = health.tts[engine];
  // A reading may not hold for long: a computer busy with a build is slow for minutes, not for good. Past its age the
  // voice is tried again and measured, so a slow spell does not keep a good voice out
  if (reading && now - reading.at > (reading.source === 'benchmark' ? STALE_BENCHMARK_MS : STALE_OBSERVED_MS))
    return true;
  if (ttsVerdict(reading?.speed) !== 'too-slow') return true;
  return chars <= SHORT_LINE_CHARS;
}

// How long a reading is believed before the next answer measures the voice again: what answers showed (a busy spell
// passes), and a deliberate check, which the user can repeat
export const STALE_OBSERVED_MS = 20 * 60 * 1000;
export const STALE_BENCHMARK_MS = 3 * 24 * 3600 * 1000;

// One short sentence: spoken before the slowness is felt
export const SHORT_LINE_CHARS = 70;

/** A voice does not count as slow from a single odd reading of a very short line. */
export function worthRecording(chars: number, audioSeconds: number): boolean {
  return chars >= 25 && audioSeconds >= 1.5;
}

export type VoiceHealthStorage = BaseStorage<VoiceHealth> & {
  getHealth: () => Promise<VoiceHealth>;
  updateHealth: (changes: Partial<VoiceHealth>) => Promise<void>;
  recordTtsSpeed: (engine: LocalTtsEngineId, speed: Speed, source: MeasuredSpeed['source']) => Promise<void>;
  recordSttSpeed: (engine: LocalSttEngineId, speed: Speed, source: MeasuredSpeed['source']) => Promise<void>;
};

const healthStorage = createStorage<VoiceHealth>('voice-health', EMPTY_VOICE_HEALTH, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const voiceHealthStore: VoiceHealthStorage = {
  ...healthStorage,
  async getHealth() {
    return { ...EMPTY_VOICE_HEALTH, ...(await healthStorage.get()) };
  },
  async updateHealth(changes) {
    await healthStorage.set({ ...(await voiceHealthStore.getHealth()), ...changes });
  },
  async recordTtsSpeed(engine, speed, source) {
    const health = await voiceHealthStore.getHealth();
    const at = Date.now();
    const next: MeasuredSpeed =
      source === 'benchmark' ? { speed: +speed.toFixed(2), at, source } : blendSpeed(health.tts[engine], speed, at);
    await healthStorage.set({ ...health, tts: { ...health.tts, [engine]: next } });
  },
  async recordSttSpeed(engine, speed, source) {
    const health = await voiceHealthStore.getHealth();
    const at = Date.now();
    const next: MeasuredSpeed =
      source === 'benchmark' ? { speed: +speed.toFixed(2), at, source } : blendSpeed(health.stt[engine], speed, at);
    await healthStorage.set({ ...health, stt: { ...health.stt, [engine]: next } });
  },
};

// ── The trace ────────────────────────────────────────────────────────────────────────────────────────

export type VoiceTraceKind = 'tts' | 'stt' | 'fallback' | 'check';

/** One thing the voices did, with no words in it: sizes and times only. */
export interface VoiceTraceEntry {
  at: number;
  kind: VoiceTraceKind;
  engine: string;
  ok: boolean;
  // Characters spoken or heard (never the text)
  chars?: number;
  // Seconds of speech made, or of audio recognised
  audioSeconds?: number;
  // Work time, and speech per second of work
  workMs?: number;
  speed?: Speed;
  // Model load, and the wait for the first sound
  loadMs?: number;
  firstAudioMs?: number;
  // Pauses the listener heard in the middle of the speech
  gaps?: { count: number; totalMs: number; longestMs: number };
  // A plain code for what happened ("slower-than-speech", "load-failed"), never a message with content in it
  note?: string;
}

export const VOICE_TRACE_LIMIT = 80;

export interface VoiceTrace {
  entries: VoiceTraceEntry[];
}

export type VoiceTraceStorage = BaseStorage<VoiceTrace> & {
  getEntries: () => Promise<VoiceTraceEntry[]>;
  append: (entry: VoiceTraceEntry) => Promise<void>;
  clear: () => Promise<void>;
};

const traceStorage = createStorage<VoiceTrace>(
  'voice-trace',
  { entries: [] },
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

export const voiceTraceStore: VoiceTraceStorage = {
  ...traceStorage,
  async getEntries() {
    return (await traceStorage.get())?.entries ?? [];
  },
  // Only the background writes, so there is one writer and nothing to merge
  async append(entry) {
    const entries = await voiceTraceStore.getEntries();
    await traceStorage.set({ entries: [...entries, entry].slice(-VOICE_TRACE_LIMIT) });
  },
  async clear() {
    await traceStorage.set({ entries: [] });
  },
};
