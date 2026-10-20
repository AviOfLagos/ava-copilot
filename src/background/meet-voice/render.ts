import {
  llmProviderStore,
  localVoice,
  personalityRateOf,
  personalityVoiceFor,
  ProviderTypeEnum,
  ttsSettingsStore,
  voiceEngineSettingsStore,
} from '@extension/storage';
import type { LocalTtsEngineId } from '@extension/storage';
import { AppError } from '@extension/shared';
import { personalityForThread } from '../personalities/voices';
import { synthesizeSpeech } from '../tts/gemini';
import { pcmToWavDataUrl } from '../tts/wav';
import { toVoiceOffscreen } from '../voice/engines/offscreen';

/**
 * Ava's words for a call, made into a WAV clip in her current personality's voice, never played here: the clip
 * goes to Nex Brain, which plays it into her meeting browser's microphone. The on-device voices (KittenTTS,
 * Kokoro) render in the offscreen document; Gemini renders with the user's Gemini key. The computer's system
 * voice (chrome.tts) can only play aloud, so it cannot speak in a call: then another engine is tried, and when
 * none can, the call is refused with a plain sentence.
 */

export const NO_VOICE_MESSAGE =
  "None of Ava's voices can speak in a call: download an on-device voice in Settings › Voice, or add a Gemini key.";

export interface RenderedClip {
  // Base64 WAV
  audio: string;
  engine: string;
}

type Engine = LocalTtsEngineId | 'gemini';

export interface RenderDeps {
  chosenEngine: () => Promise<string>;
  geminiKey: () => Promise<string | null>;
  local: (engine: LocalTtsEngineId, text: string, voice: string | undefined, rate: number) => Promise<string>;
  gemini: (key: string, text: string, voice: string | undefined) => Promise<string>;
  voiceFor: (engine: Engine) => Promise<{ voice: string | undefined; rate: number }>;
}

/** The engines to try, the user's own choice first, then the ones that render without a download or a key. */
export function engineOrder(chosen: string, hasGeminiKey: boolean): Engine[] {
  const order: Engine[] = [];
  if (chosen === 'kitten' || chosen === 'kokoro') order.push(chosen);
  if (chosen === 'gemini' && hasGeminiKey) order.push('gemini');
  for (const engine of ['kitten', 'kokoro'] as const) if (!order.includes(engine)) order.push(engine);
  if (hasGeminiKey && !order.includes('gemini')) order.push('gemini');
  return order;
}

/** Renders the words with the first engine that can; throws NO_VOICE_MESSAGE when none can. */
export async function renderForCall(text: string, deps: RenderDeps = defaultRenderDeps(null)): Promise<RenderedClip> {
  const key = await deps.geminiKey();
  for (const engine of engineOrder(await deps.chosenEngine(), Boolean(key))) {
    try {
      const { voice, rate } = await deps.voiceFor(engine);
      const audio =
        engine === 'gemini'
          ? await deps.gemini(key as string, text, voice)
          : await deps.local(engine, text, voice, rate);
      if (audio) return { audio, engine };
    } catch {
      // Not downloaded, failed to load, or the key was refused: the next engine is tried
    }
  }
  throw new AppError('unavailable', NO_VOICE_MESSAGE, { retryable: false });
}

async function geminiKey(): Promise<string | null> {
  const providers = await llmProviderStore.getAllProviders();
  const match = Object.values(providers).find(provider => provider.type === ProviderTypeEnum.Gemini && provider.apiKey);
  return match?.apiKey ?? null;
}

/** The real engines, with the voice and pace of the personality of the chat the words came from. */
export function defaultRenderDeps(thread: { workspaceId?: string | null; agentId?: string | null } | null): RenderDeps {
  return {
    chosenEngine: async () => (await ttsSettingsStore.getSettings()).engine,
    geminiKey,
    voiceFor: async engine => {
      const settings = await ttsSettingsStore.getSettings();
      const personality = await personalityForThread(thread).catch(() => null);
      const own = personalityVoiceFor(engine, personality);
      const voice =
        own ?? (engine === 'gemini' ? undefined : localVoice(engine, await voiceEngineSettingsStore.getSettings()));
      return { voice, rate: personalityRateOf(personality) ?? settings.rate ?? 1 };
    },
    local: async (engine, text, voice, rate) => {
      const reply = await toVoiceOffscreen<{ ok?: boolean; audio?: string; error?: string }>({
        type: 'local_tts_render',
        engine,
        text,
        voice: voice ?? '',
        rate,
      });
      if (!reply?.ok || !reply.audio)
        throw new AppError('unavailable', reply?.error || 'The local voice made no sound.');
      return reply.audio;
    },
    gemini: async (key, text, voice) => {
      const { base64, sampleRateHz } = await synthesizeSpeech(key, text, { voice });
      return pcmToWavDataUrl(base64, sampleRateHz).slice('data:audio/wav;base64,'.length);
    },
  };
}
