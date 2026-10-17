import { t } from '@extension/i18n';
import { llmProviderStore, localSttChoice, speechToTextModelStore, voiceEngineSettingsStore } from '@extension/storage';
import type { ProviderConfig } from '@extension/storage';
import { AppError } from '@extension/shared';
import { SpeechToTextService } from '../services/speechToText';
import { installedVoiceModels } from './engines/models';
import { toVoiceOffscreen } from './engines/offscreen';
import { toOffscreen } from '../offscreen';

/**
 * Dictation in the chat box: writing the words down, and keeping the voice conversation and "Hey Ava" out of the
 * way while the user dictates (they would otherwise hear the same words and answer them too).
 */

/** Whether a Gemini speech-to-text model is set up: a model chosen, on a Gemini provider with a key. */
export function hasGeminiSpeechToText(
  config: { provider?: string; modelName?: string } | null | undefined,
  providers: Record<string, ProviderConfig>,
): boolean {
  if (!config?.provider || !config.modelName) return false;
  const provider = providers[config.provider];
  return provider?.type === 'gemini' && Boolean(provider.apiKey);
}

export interface DictationDeps {
  gemini: (base64: string, mediaType: string) => Promise<string>;
  local: (base64: string) => Promise<string>;
  geminiReady: () => Promise<boolean>;
}

const browserDeps: DictationDeps = {
  geminiReady: async () =>
    hasGeminiSpeechToText(
      await speechToTextModelStore.getSpeechToTextModel(),
      await llmProviderStore.getAllProviders(),
    ),
  gemini: async (base64, mediaType) =>
    (await SpeechToTextService.create(await llmProviderStore.getAllProviders())).transcribeAudio(base64, mediaType),
  local: async base64 => {
    const stt = localSttChoice(await voiceEngineSettingsStore.getSettings(), await installedVoiceModels());
    if (!stt) throw new AppError('not_found', t('voice_engine_dictation_missing'));
    const reply = await toVoiceOffscreen<{ ok?: boolean; text?: string; error?: string }>({
      type: 'stt_transcribe',
      stt,
      audio: base64,
    });
    if (!reply?.ok) throw new AppError('unknown', reply?.error || t('bg_cmd_stt_failed'));
    return reply.text ?? '';
  },
};

/**
 * Writes down a recording: with Gemini when its speech-to-text is set up, else on this computer with the local
 * recogniser, so dictation works with no key at all.
 */
export async function transcribeSpeech(audio: string, mediaType = 'audio/webm', deps = browserDeps): Promise<string> {
  // Remove the data URL prefix if present
  const base64 = audio.startsWith('data:') ? audio.split(',')[1] : audio;
  if (await deps.geminiReady()) return deps.gemini(base64, mediaType);
  return deps.local(base64);
}

// The panel connection dictating now; its closing gives the microphone back
let holder: unknown = null;

/**
 * Dictation started or ended in a panel: the conversation stops hearing the microphone (typed turns still go) and
 * the wake word is not listened for, until it ends. Only when the offscreen document is open: with none, nothing
 * is listening anyway. The offscreen document gives it back by itself after a few minutes, whatever happens.
 */
export async function holdForDictation(on: boolean, by: unknown = null): Promise<void> {
  if (!on && holder !== null && by !== null && by !== holder) return;
  holder = on ? by : null;
  const open = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (open.length === 0) return;
  await toOffscreen({ type: 'dictation_hold', on }).catch(() => {});
}

/** A panel closed: if it was dictating, the microphone goes back. */
export function releaseDictation(by: unknown): void {
  if (holder !== null && holder === by) void holdForDictation(false, by);
}
