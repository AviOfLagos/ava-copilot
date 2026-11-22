import { t } from '@extension/i18n';
import {
  economyTts,
  localSttChoice,
  resolveVoiceMode,
  localVoice,
  sttModelId,
  threadTts,
  threadVoiceEngines,
  personalityRateOf,
  personalityVoiceFor,
  ttsSettingsStore,
  voiceEngineSettingsStore,
  voiceHealthStore,
  voiceIdentityStore,
  voiceTtsEngine,
} from '@extension/storage';
import type {
  InstalledVoiceModels,
  LocalTtsEngineId,
  VoiceHealth,
  Personality,
  ThreadVoice,
  TtsSettingsConfig,
  VoiceEngineSettings,
  VoiceModelId,
} from '@extension/storage';
import { AppError } from '@extension/shared';
import { noteSlowFallback, slowVoice } from './health';
import { installedVoiceModels } from './models';
import type { EconomyEngines } from './wire';

/**
 * What a voice conversation runs on: Gemini Live, or the economy engines (local speech-to-text, a local or system
 * voice) chosen from the settings and the models installed.
 */

export const SETUP_COMMAND = 'node scripts/voice-models-setup.mjs';

export type VoiceFeature = 'talk' | 'dictation' | 'wake' | 'ambient';

export interface ModelsNeeded {
  // Without these the feature cannot run on the device
  required: VoiceModelId[];
  // Better with these (KittenTTS instead of the system voices); the feature runs without them
  optional: VoiceModelId[];
}

/**
 * The local models a feature still needs before it can start, so the panel can offer the download first: a
 * conversation on the device needs a recogniser (the one chosen, Moonshine tiny by default) and gets KittenTTS
 * unless the system voices were picked; one that would go to Gemini Live needs nothing. Dictation needs a
 * recogniser unless Gemini writes it down. The wake word needs the Vosk model.
 */
export function modelsNeeded(
  feature: VoiceFeature,
  {
    settings,
    tts,
    installed,
    hasGeminiKey,
    geminiSpeechToText,
  }: {
    settings: VoiceEngineSettings;
    tts: { engine: string; engineChosen?: boolean };
    installed: InstalledVoiceModels;
    hasGeminiKey: boolean;
    geminiSpeechToText: boolean;
  },
): ModelsNeeded {
  const none: ModelsNeeded = { required: [], optional: [] };
  if (feature === 'wake') return installed.vosk ? none : { required: ['vosk'], optional: [] };
  const sttReady = localSttChoice(settings, installed) !== null;
  const stt: VoiceModelId[] = sttReady
    ? []
    : [sttModelId(settings.stt === 'gemini' ? 'moonshine' : settings.stt, settings.moonshineSize)];
  if (feature === 'dictation') return geminiSpeechToText ? none : { required: stt, optional: [] };
  // Ambient listening never uses Gemini: it always needs a recogniser on the device
  if (feature === 'ambient') return { required: stt, optional: [] };
  if (resolveVoiceMode(settings, { hasGeminiKey }) === 'live') return none;
  const engine = voiceTtsEngine(tts.engine);
  const chosen = tts.engineChosen ?? true;
  let voice: VoiceModelId | null = null;
  if ((engine === 'kitten' || engine === 'kokoro') && !installed[engine]) voice = engine;
  else if (engine !== 'kokoro' && !(engine === 'system' && chosen) && !installed.kitten && !installed.kokoro) {
    voice = 'kitten';
  }
  return { required: stt, optional: voice ? [voice] : [] };
}

/**
 * The engines for an economy conversation, or why there are none: a plain sentence with the fix.
 */
export function chooseEconomyEngines(
  settings: VoiceEngineSettings,
  // The stored engine is checked here: TtsEngineId may not list the local engines yet
  tts: Pick<TtsSettingsConfig, 'voice' | 'rate'> & { engine: string; engineChosen?: boolean },
  installed: InstalledVoiceModels,
  hearing?: { language: string },
  // What was measured on this computer: a local voice that makes speech slower than it plays gives way to the system's
  health?: Pick<VoiceHealth, 'tts'>,
): { engines: EconomyEngines; slow?: { engine: LocalTtsEngineId; speed: number } } | { error: string } {
  const stt = localSttChoice(settings, installed, hearing);
  if (!stt) {
    return { error: t('voice_engine_local_missing') };
  }
  // The untouched default (the system voices) gives way to KittenTTS when it is installed
  const wanted = economyTts(voiceTtsEngine(tts.engine), installed, tts.engineChosen ?? true);
  const slow = health ? slowVoice(wanted, health) : null;
  const voice = slow ? 'system' : wanted;
  return {
    engines: {
      stt,
      tts: {
        engine: voice,
        // A system voice name from Settings means nothing to a local voice, and a local voice's name nothing to the system
        voice: voice === 'system' ? (wanted === 'system' ? tts.voice : '') : localVoice(voice, settings),
        rate: tts.rate,
      },
    },
    ...(slow ? { slow } : {}),
  };
}

/**
 * The offscreen options that make a voice conversation an economy one, or null for Gemini Live (see
 * resolveVoiceMode: Live with a Gemini key unless economy was picked, or the chat's own voice setup says otherwise).
 * Spread over the Live options in VoiceManager.start; `instructions` and `tools`
 * stay the manager's own.
 *
 * @throws AppError when the conversation must run on the device but its speech files are missing
 */
export async function economyVoiceOptions(
  // The conversation's personality: its voice and pace, when set, replace the voice settings
  personality?: Pick<Personality, 'voices' | 'rate'> | null,
  hasGeminiKey = false,
  // The chat's own voice setup, over Settings
  voice?: ThreadVoice | null,
): Promise<{ mode: 'economy'; economy: EconomyEngines } | null> {
  const stored = threadVoiceEngines(await voiceEngineSettingsStore.getSettings(), voice);
  const installed = await installedVoiceModels();
  if (resolveVoiceMode(stored, { hasGeminiKey }) === 'live') return null;
  const tts = threadTts(await ttsSettingsStore.getSettings(), voice);
  const language = voice?.language ?? (await voiceIdentityStore.getSettings()).language;
  const kitten = personalityVoiceFor('kitten', personality);
  const kokoro = personalityVoiceFor('kokoro', personality);
  const settings = {
    ...stored,
    ...(kitten ? { kittenVoice: kitten } : {}),
    ...(kokoro ? { kokoroVoice: kokoro } : {}),
  };
  const choice = chooseEconomyEngines(
    settings,
    {
      ...tts,
      voice: personalityVoiceFor('system', personality) ?? tts.voice,
      rate: personalityRateOf(personality) ?? tts.rate,
    },
    installed,
    { language },
    await voiceHealthStore.getHealth(),
  );
  if ('error' in choice) throw new AppError('not_found', choice.error);
  if (choice.slow) void noteSlowFallback(choice.slow);
  return { mode: 'economy', economy: choice.engines };
}
