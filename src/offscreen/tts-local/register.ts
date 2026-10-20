import { OFFSCREEN_VOICE_TARGET } from '../../background/voice/engines/wire';
import type { EconomyEngines, VoiceEngineRuntimeStatus } from '../../background/voice/engines/wire';
import { heardLately, listenOnce } from '../stt/listen';
import { sttStatus, unloadStt } from '../stt/pool';
import { transcribeRecording } from '../stt/transcribe';
import type { LocalVoiceEngine } from './protocol';
import { localTts } from './shared';
import { lastSpokenLine } from '../lines';
import { encodeWav, toBase64 } from '../pcm';

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
    // Speech made into a WAV file and handed back, not played (Ava's words for a call, sent to Nex Brain)
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
