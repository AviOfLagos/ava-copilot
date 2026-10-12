import {
  economyTts,
  localSttChoice,
  localVoice,
  ttsSettingsStore,
  voiceEngineSettingsStore,
  voiceTtsEngine,
} from '@extension/storage';
import type { InstalledVoiceModels, TtsSettingsConfig, VoiceEngineSettings } from '@extension/storage';
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
  tts: Pick<TtsSettingsConfig, 'voice' | 'rate'> & { engine: string },
  installed: InstalledVoiceModels,
): { engines: EconomyEngines } | { error: string } {
  const stt = localSttChoice(settings, installed);
  if (!stt) {
    return {
      error: `Economy voice needs a speech model on this computer. Run ${SETUP_COMMAND}, then rebuild the extension.`,
    };
  }
  const voice = economyTts(voiceTtsEngine(tts.engine), installed);
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
 * The offscreen options that make a voice conversation an economy one, or null for Gemini Live. Spread over the
 * Live options in VoiceManager.start; `instructions` and `tools` stay the manager's own.
 *
 * @throws AppError when economy mode is chosen but no local speech model is installed
 */
export async function economyVoiceOptions(): Promise<{ mode: 'economy'; economy: EconomyEngines } | null> {
  const settings = await voiceEngineSettingsStore.getSettings();
  if (settings.mode !== 'economy') return null;
  const choice = chooseEconomyEngines(settings, await ttsSettingsStore.getSettings(), await installedVoiceModels());
  if ('error' in choice) throw new AppError('not_found', choice.error);
  return { mode: 'economy', economy: choice.engines };
}
