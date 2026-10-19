/**
 * Names shared by the background and the offscreen document for the local voice engines, with no code behind them
 * (the offscreen bundle imports this, so it stays free of zod and the background's modules).
 */

// Messages to the offscreen document's local voice and speech commands; the shared router answers only 'offscreen'
export const OFFSCREEN_VOICE_TARGET = 'offscreen-voice';

/** What an economy conversation needs to hear and speak, chosen by the background from settings and models. */
export interface EconomyEngines {
  stt: {
    engine: 'moonshine' | 'whisper' | 'vosk';
    model?: 'moonshine-tiny' | 'moonshine-base' | 'whisper-base';
    webgpu?: boolean;
  };
  tts: { engine: 'kitten' | 'kokoro' | 'system'; voice: string; rate: number };
}

/** What the offscreen document reports about the local engines, for Settings and tests. */
export interface VoiceEngineRuntimeStatus {
  tts: {
    loaded: boolean;
    speaking: boolean;
    engine: string | null;
    requests: number;
    loadMs: number | null;
    firstAudioMs: number | null;
    speedFactor: number | null;
    peakRms: number;
    playedSeconds: number;
  };
  stt: { loaded: string | null; lastLoad: { engine: string; device: string; ms: number } | null };
  // The last words a local recogniser heard in a conversation, and how long it took
  lastHeard: { text: string; ms: number } | null;
  // The last line said in another voice in a conversation (an agent's answer), and the voice it used
  lastLine?: { text: string; engine: string; voice: string; at: number } | null;
}
