import { t } from '@extension/i18n';
import {
  hearsOnDevice,
  llmProviderStore,
  localSttChoice,
  speechToTextModelStore,
  threadVoiceEngines,
  voiceEngineSettingsStore,
  voiceIdentityStore,
} from '@extension/storage';
import type { ProviderConfig, ThreadVoice } from '@extension/storage';
import { AppError } from '@extension/shared';
import { geminiSpeechConfig } from '../services/geminiSpeech';
import { SpeechToTextService } from '../services/speechToText';
import { installedVoiceModels } from './engines/models';
import { toVoiceOffscreen } from './engines/offscreen';
import { toOffscreen } from '../offscreen';
import { registerOffscreenBusy } from '../registry';
import { correctTranscript, vocabularyHint } from './vocabulary';
import type { CorrectionResult } from './vocabulary';

/**
 * Dictation in the chat box: writing the words down, and keeping the voice conversation and "Hey Ava" out of the
 * way while the user dictates (they would otherwise hear the same words and answer them too).
 */

/** Whether Gemini can write speech down: a Gemini provider with a key. */
export function hasGeminiSpeechToText(
  config: { provider?: string; modelName?: string } | null | undefined,
  providers: Record<string, ProviderConfig>,
): boolean {
  return geminiSpeechConfig(config, providers) !== null;
}

export interface DictationDeps {
  // `hint` is the user's own words, for the recogniser (see ./vocabulary)
  gemini: (base64: string, mediaType: string, voice?: ThreadVoice | null, hint?: string) => Promise<string>;
  local: (base64: string, voice?: ThreadVoice | null) => Promise<string>;
  geminiReady: (voice?: ThreadVoice | null) => Promise<boolean>;
  // Words the recogniser tends to get wrong, and the correction of what it wrote; left out, nothing is added or changed
  hint?: (workspaceId: string | null) => Promise<string>;
  correct?: (text: string, workspaceId: string | null) => Promise<CorrectionResult>;
}

const browserDeps: DictationDeps = {
  // Never when Settings or the chat keep speech on this computer
  geminiReady: async voice =>
    !hearsOnDevice(threadVoiceEngines(await voiceEngineSettingsStore.getSettings(), voice)) &&
    hasGeminiSpeechToText(
      await speechToTextModelStore.getSpeechToTextModel(),
      await llmProviderStore.getAllProviders(),
    ),
  gemini: async (base64, mediaType, voice, hint) =>
    (await SpeechToTextService.create(await llmProviderStore.getAllProviders())).transcribeAudio(
      base64,
      mediaType,
      voice?.language,
      hint,
    ),
  local: async (base64, voice) => {
    const language = voice?.language ?? (await voiceIdentityStore.getSettings()).language;
    const settings = threadVoiceEngines(await voiceEngineSettingsStore.getSettings(), voice);
    const stt = localSttChoice(settings, await installedVoiceModels(), { language });
    if (!stt) throw new AppError('not_found', t('voice_engine_dictation_missing'));
    const reply = await toVoiceOffscreen<{ ok?: boolean; text?: string; error?: string }>({
      type: 'stt_transcribe',
      stt,
      audio: base64,
    });
    if (!reply?.ok) throw new AppError('unknown', reply?.error || t('bg_cmd_stt_failed'));
    return reply.text ?? '';
  },
  hint: workspaceId => vocabularyHint(workspaceId),
  correct: (text, workspaceId) => correctTranscript(text, { workspaceId }),
};

// Recordings being written down on this computer now. The offscreen document does the work, so it must not be
// closed meanwhile: the wake word's minute check and the end of a conversation close it when nothing uses it, and
// closing it mid-way is what Chrome reports as "the message channel closed before a response was received".
let writing = 0;

/** Whether a recording is being written down in the offscreen document now. */
export function dictationBusy(): boolean {
  return writing > 0;
}

registerOffscreenBusy('dictation', async () => dictationBusy());

/** Whether an error is Chrome's messaging failing (the other side went away), not the recogniser's own. */
export function isChannelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /message channel closed|message port closed|Receiving end does not exist|Extension context invalidated/i.test(
    message,
  );
}

/** What the panel shows when dictation fails: a plain sentence, never Chrome's internal wording. */
export function sttErrorMessage(error: unknown): string {
  if (isChannelError(error)) return t('chat_stt_unanswered');
  if (error instanceof Error && error.message) return error.message;
  return t('bg_cmd_stt_failed');
}

/**
 * Writes down a recording, in the chat's voice setup when it has one. By default with Gemini when there is a key
 * and speech was not kept on this computer, else here, and here when Gemini fails, so dictation works with no key and no network. A chat set to
 * a recogniser uses that one and no other. Writing down on this computer is pure work on the recording, so when
 * the offscreen document went away under it, it is asked once more.
 */
export async function transcribeAndCorrect(
  audio: string,
  mediaType = 'audio/webm',
  deps = browserDeps,
  voice: ThreadVoice | null = null,
  workspaceId: string | null = null,
): Promise<CorrectionResult> {
  // Remove the data URL prefix if present
  const base64 = audio.startsWith('data:') ? audio.split(',')[1] : audio;
  const local = async () => {
    writing++;
    try {
      try {
        return await deps.local(base64, voice);
      } catch (error) {
        if (!isChannelError(error)) throw error;
        return await deps.local(base64, voice);
      }
    } finally {
      writing--;
    }
  };
  const written = await (async () => {
    if (voice?.hear && voice.hear !== 'gemini') return local();
    if (!(await deps.geminiReady(voice))) return local();
    try {
      const hint = (await deps.hint?.(workspaceId).catch(() => '')) || '';
      return await deps.gemini(base64, mediaType, voice, ...(hint ? [hint] : []));
    } catch (error) {
      if (voice?.hear === 'gemini') throw error;
      return local().catch(() => {
        throw error;
      });
    }
  })();
  // The one place the words are corrected, whichever recogniser wrote them
  return deps.correct ? deps.correct(written, workspaceId) : { text: written, changes: [], unsure: [] };
}

/** The same, as plain text. */
export async function transcribeSpeech(
  audio: string,
  mediaType = 'audio/webm',
  deps = browserDeps,
  voice: ThreadVoice | null = null,
  workspaceId: string | null = null,
): Promise<string> {
  return (await transcribeAndCorrect(audio, mediaType, deps, voice, workspaceId)).text;
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
