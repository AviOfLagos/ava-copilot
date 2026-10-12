import { KITTEN_VOICES, KOKORO_VOICES, localVoice, voiceEngineSettingsStore } from '@extension/storage';
import type { LocalTtsEngineId } from '@extension/storage';
import { AppError } from '@extension/shared';
import type { SpeakOptions, TtsEngine } from '../../tts/types';
import { askVoiceOffscreen, toVoiceOffscreen } from './offscreen';

/**
 * The local voices behind WS2's TTS interface: KittenTTS and Kokoro speak in the offscreen document (a worker makes
 * the audio, the document plays it), nothing leaves the computer. `speak()` resolves once the answer has been
 * heard, the same contract as the system voices.
 */

type SpeakReply = { ok?: boolean; error?: string; ms?: number; stats?: Record<string, unknown> };

let speakingNow = false;

function isVoiceOf(engine: LocalTtsEngineId, voice: string | undefined): voice is string {
  const voices: readonly string[] = engine === 'kokoro' ? KOKORO_VOICES : KITTEN_VOICES;
  return !!voice && voices.includes(voice);
}

/** Speaks with a local engine and returns the offscreen document's timings. */
export async function speakLocally(
  engine: LocalTtsEngineId,
  text: string,
  options: SpeakOptions = {},
): Promise<SpeakReply> {
  // The voice chosen for this engine; a system voice name from Settings › Voice output means nothing here
  const voice = isVoiceOf(engine, options.voice)
    ? options.voice
    : localVoice(engine, await voiceEngineSettingsStore.getSettings());
  speakingNow = true;
  try {
    const reply = await toVoiceOffscreen<SpeakReply>({
      type: 'local_tts_speak',
      engine,
      text,
      voice,
      rate: options.rate ?? 1,
    });
    if (!reply?.ok) throw new AppError('unavailable', reply?.error || 'The local voice could not speak.');
    return reply;
  } finally {
    speakingNow = false;
  }
}

export function localTtsEngine(engine: LocalTtsEngineId): TtsEngine {
  return {
    speak: async (text, options) => {
      await speakLocally(engine, text, options);
    },
    stop: stopLocalSpeech,
    speaking: localSpeaking,
  };
}

export async function stopLocalSpeech(): Promise<void> {
  await askVoiceOffscreen({ type: 'local_tts_stop' });
}

export async function localSpeaking(): Promise<boolean> {
  if (speakingNow) return true;
  return (await askVoiceOffscreen<{ running?: boolean }>({ type: 'local_tts_running' }))?.running ?? false;
}
