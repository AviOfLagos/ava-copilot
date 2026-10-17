import { t } from '@extension/i18n';
import {
  economyTts,
  localSttChoice,
  resolveVoiceMode,
  localVoice,
  personalityRateOf,
  personalityVoiceFor,
  ttsSettingsStore,
  voiceEngineSettingsStore,
  voiceTtsEngine,
} from '@extension/storage';
import type { InstalledVoiceModels, Personality, TtsSettingsConfig, VoiceEngineSettings } from '@extension/storage';
import { AppError } from '@extension/shared';
import { installedVoiceModels } from './models';
import type { EconomyEngines } from './wire';

/**
 * What a voice conversation runs on: Gemini Live, or the economy engines (local speech-to-text, a local or system
 * voice) chosen from the settings and the models installed.
 */

export const SETUP_COMMAND = 'node scripts/voice-models-setup.mjs';

/**
 * The engines for an economy conversation, or why there are none: a plain sentence with the fix.
 */
export function chooseEconomyEngines(
  settings: VoiceEngineSettings,
  // The stored engine is checked here: TtsEngineId may not list the local engines yet
  tts: Pick<TtsSettingsConfig, 'voice' | 'rate'> & { engine: string; engineChosen?: boolean },
  installed: InstalledVoiceModels,
): { engines: EconomyEngines } | { error: string } {
  const stt = localSttChoice(settings, installed);
  if (!stt) {
    return { error: t('voice_engine_local_missing') };
  }
  // The untouched default (the system voices) gives way to KittenTTS when it is installed
  const voice = economyTts(voiceTtsEngine(tts.engine), installed, tts.engineChosen ?? true);
  return {
    engines: {
      stt,
      tts: {
        engine: voice,
        voice: voice === 'system' ? tts.voice : localVoice(voice, settings),
        rate: tts.rate,
      },
    },
  };
}

/**
 * The offscreen options that make a voice conversation an economy one, or null for Gemini Live (see
 * resolveVoiceMode: on the device by default, Live only when picked and a key is there, or when the speech files
 * are missing and a key is there). Spread over the Live options in VoiceManager.start; `instructions` and `tools`
 * stay the manager's own.
 *
 * @throws AppError when the conversation must run on the device but its speech files are missing
 */
export async function economyVoiceOptions(
  // The conversation's personality: its voice and pace, when set, replace the voice settings
  personality?: Pick<Personality, 'voice' | 'rate'> | null,
  hasGeminiKey = false,
): Promise<{ mode: 'economy'; economy: EconomyEngines } | null> {
  const stored = await voiceEngineSettingsStore.getSettings();
  const installed = await installedVoiceModels();
  const mode = resolveVoiceMode(stored, { hasGeminiKey, localReady: localSttChoice(stored, installed) !== null });
  if (mode === 'live') return null;
  const tts = await ttsSettingsStore.getSettings();
  const voice = personality?.voice?.trim() ?? '';
  const settings = {
    ...stored,
    ...(personalityVoiceFor('kitten', personality) ? { kittenVoice: voice } : {}),
    ...(personalityVoiceFor('kokoro', personality) ? { kokoroVoice: voice } : {}),
  };
  const choice = chooseEconomyEngines(
    settings,
    {
      ...tts,
      voice: personalityVoiceFor('system', personality) ?? tts.voice,
      rate: personalityRateOf(personality) ?? tts.rate,
    },
    installed,
  );
  if ('error' in choice) throw new AppError('not_found', choice.error);
  return { mode: 'economy', economy: choice.engines };
}
