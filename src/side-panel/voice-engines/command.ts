import type { InstalledVoiceModels, VoiceEngineSettings, VoiceTtsEngineId } from '@extension/storage';

/**
 * The command that installs what the chosen engines still need: the voice models script with a flag per optional
 * model, and the wake word's script for Vosk (its model is the one "Hey Ava" uses). The plain voice models command
 * when nothing chosen is missing.
 */
export function setupCommand(
  settings: Pick<VoiceEngineSettings, 'stt' | 'moonshineSize'>,
  ttsEngine: VoiceTtsEngineId,
  installed: InstalledVoiceModels,
): string {
  const flags: string[] = [];
  if (settings.stt === 'moonshine' && settings.moonshineSize === 'base' && !installed['moonshine-base']) {
    flags.push('--moonshine-base');
  }
  if (settings.stt === 'whisper' && !installed['whisper-base']) flags.push('--whisper');
  if (ttsEngine === 'kokoro' && !installed.kokoro) flags.push('--kokoro');
  const commands = [['node scripts/voice-models-setup.mjs', ...flags].join(' ')];
  if (settings.stt === 'vosk' && !installed.vosk) commands.push('node scripts/wake-word-setup.mjs');
  return commands.join(' && ');
}
