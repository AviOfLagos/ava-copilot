import { OFFSCREEN_VOICE_TARGET } from '../../background/voice/engines/wire';
import type { EconomyEngines, VoiceEngineRuntimeStatus } from '../../background/voice/engines/wire';
import { heardLately, listenOnce } from '../stt/listen';
import { hasWebGpu } from '../stt/runtime';
import { sttStatus, unloadStt } from '../stt/pool';
import { transcribeRecording } from '../stt/transcribe';
import type { LocalVoiceEngine } from './protocol';
import { localTts } from './shared';
import { lastSpokenLine } from '../lines';
import { encodeWav, toBase64 } from '../pcm';
import { decodeWav, encodeVoiceNote } from '../voice-note/encode';

/**
 * The local voice and speech commands of the offscreen document, on a target of their own so the shared router in
 * offscreen/index.ts never sees them (it answers every 'offscreen' message, known or not). Only the extension's own
 * pages and background may send them.
 */

type Message = { target?: string; type?: string; [key: string]: unknown };

const isEngine = (value: unknown): value is LocalVoiceEngine => value === 'kitten' || value === 'kokoro';

function runtimeStatus(): VoiceEngineRuntimeStatus {
  const tts = localTts();
  return {
    tts: { ...tts.stats, loaded: tts.loaded, speaking: tts.speaking },
    stt: sttStatus(),
    lastHeard: heardLately(),
    lastLine: lastSpokenLine(),
  };
}

// A fixed line with a comma and a full stop, about four seconds of speech: the same for every computer, so the speeds
// can be compared
const BENCHMARK_TEXT = 'The quick brown fox jumps over the lazy dog, then rests.';

interface BenchmarkRequest {
  engines: { engine: LocalVoiceEngine; voice: string }[];
  stt?: EconomyEngines['stt'];
}

// A voice or recogniser that has not answered by then is reported as stuck, so one that hangs does not stall the check
const TTS_CHECK_LIMIT_MS = 90_000;
const STT_CHECK_LIMIT_MS = 45_000;

function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer in ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

const words = (text: string) => text.toLowerCase().match(/[a-z']+/g) ?? [];

/** The share of the spoken words a recogniser got back, in order. */
function wordsRight(said: string, heard: string): number {
  const want = words(said);
  const got = words(heard);
  if (!want.length) return 0;
  return want.filter((word, index) => got[index] === word).length / want.length;
}

/**
 * Times the local voices on this computer: each installed voice makes a fixed line (a short warm-up first, so
 * the runtime's start-up is not counted), then the recogniser writes down what a voice said. Nothing is played.
 */
async function benchmark(request: BenchmarkRequest) {
  const machine = {
    cores: navigator.hardwareConcurrency || 1,
    memoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    webgpu: await hasWebGpu(),
    threads: Boolean(globalThis.crossOriginIsolated),
  };
  const tts: Record<string, { ok: boolean; speed?: number; loadMs?: number; audioSeconds?: number; error?: string }> =
    {};
  let heardSample: { samples: Float32Array; sampleRate: number } | null = null;
  for (const { engine, voice } of request.engines) {
    try {
      const loadStarted = performance.now();
      await within(localTts().warm(engine), TTS_CHECK_LIMIT_MS, 'The voice');
      const loadMs = Math.round(performance.now() - loadStarted);
      await within(
        localTts().render({ engine, text: 'Hello there.', voice, rate: 1 }),
        TTS_CHECK_LIMIT_MS,
        'The voice',
      );
      const started = performance.now();
      const speech = await within(
        localTts().render({ engine, text: BENCHMARK_TEXT, voice, rate: 1 }),
        TTS_CHECK_LIMIT_MS,
        'The voice',
      );
      const workMs = performance.now() - started;
      const audioSeconds = speech.samples.length / speech.sampleRate;
      tts[engine] = { ok: audioSeconds > 0, speed: +(audioSeconds / (workMs / 1000)).toFixed(2), loadMs, audioSeconds };
      heardSample ??= speech;
    } catch (error) {
      tts[engine] = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  let stt: { ok: boolean; speed?: number; right?: number; error?: string } | undefined;
  if (request.stt && heardSample) {
    try {
      const wav = toBase64(encodeWav(heardSample.samples, heardSample.sampleRate));
      // The first run loads the recogniser; the second is timed
      await within(transcribeRecording(request.stt, wav), STT_CHECK_LIMIT_MS, 'The recogniser');
      const started = performance.now();
      const text = await within(transcribeRecording(request.stt, wav), STT_CHECK_LIMIT_MS, 'The recogniser');
      const ms = performance.now() - started;
      const seconds = heardSample.samples.length / heardSample.sampleRate;
      stt = {
        ok: true,
        speed: +(seconds / (ms / 1000)).toFixed(2),
        right: +wordsRight(BENCHMARK_TEXT, text).toFixed(2),
      };
    } catch (error) {
      stt = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: true, machine, tts, stt };
}

async function handle(message: Message): Promise<unknown> {
  switch (message.type) {
    case 'local_tts_speak': {
      if (!isEngine(message.engine)) return { ok: false, error: 'Unknown voice engine' };
      const started = performance.now();
      try {
        await localTts().speak({
          engine: message.engine,
          text: String(message.text ?? '').slice(0, 20_000),
          voice: String(message.voice ?? ''),
          rate: typeof message.rate === 'number' ? message.rate : 1,
        });
        return { ok: true, ms: Math.round(performance.now() - started), stats: localTts().stats };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    // Speech made into a WAV file and handed back, not played (Ava's words for a call, sent to Ava Brain)
    case 'local_tts_render': {
      if (!isEngine(message.engine)) return { ok: false, error: 'Unknown voice engine' };
      const started = performance.now();
      try {
        const speech = await localTts().render({
          engine: message.engine,
          text: String(message.text ?? '').slice(0, 4000),
          voice: String(message.voice ?? ''),
          rate: typeof message.rate === 'number' ? message.rate : 1,
        });
        if (!speech.samples.length) return { ok: false, error: 'The voice made no sound' };
        return {
          ok: true,
          audio: toBase64(encodeWav(speech.samples, speech.sampleRate)),
          durationMs: Math.round((speech.samples.length / speech.sampleRate) * 1000),
          ms: Math.round(performance.now() - started),
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    // A WAV clip made into a WhatsApp voice note (Ogg/Opus, with its length and bars), for Ava Brain to send
    case 'voice_note_encode':
      try {
        const binary = atob(String(message.wav ?? ''));
        const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
        const { samples, sampleRate } = decodeWav(bytes);
        const note = await encodeVoiceNote(samples, sampleRate);
        return { ok: true, audio: toBase64(note.ogg), seconds: note.seconds, waveform: note.waveform };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    case 'local_tts_warm':
      if (!isEngine(message.engine)) return { ok: false, error: 'Unknown voice engine' };
      try {
        await localTts().warm(message.engine);
        return { ok: true, loadMs: localTts().stats.loadMs };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    case 'local_tts_stop':
      localTts().stop();
      return { ok: true };
    case 'local_tts_running':
      return { running: localTts().speaking };
    case 'voice_engine_runtime':
      return runtimeStatus();
    case 'voice_benchmark':
      try {
        return await benchmark(message as unknown as BenchmarkRequest);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    case 'voice_engine_unload':
      localTts().unload();
      unloadStt();
      return { ok: true };
    case 'stt_listen_once':
      try {
        return {
          ok: true,
          ...(await listenOnce(message.stt as EconomyEngines['stt'], Number(message.timeoutMs) || 15_000)),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          micDenied: error instanceof DOMException && error.name === 'NotAllowedError',
        };
      }
    // A recording written down on the device (the chat box's dictation without Gemini speech-to-text)
    case 'stt_transcribe':
      try {
        const started = performance.now();
        const text = await transcribeRecording(message.stt as EconomyEngines['stt'], String(message.audio ?? ''));
        return { ok: true, text, ms: Math.round(performance.now() - started) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    default:
      return { ok: false, error: `Unknown command ${String(message.type)}` };
  }
}

// Each answer's sizes and times go to the background's voice trace (the offscreen document keeps no storage of its own)
localTts().onSpoken = report => {
  void chrome.runtime.sendMessage({ type: 'voice_trace_tts', report }).catch(() => {});
};

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  if (message?.target !== OFFSCREEN_VOICE_TARGET || sender.id !== chrome.runtime.id) return;
  // Extension pages and the background only, never a content script in a web page
  if (sender.tab || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  // Every path answers, a command that throws too: a promised reply that never comes is Chrome's "message channel
  // closed" error at the background
  void handle(message).then(sendResponse, error =>
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});
