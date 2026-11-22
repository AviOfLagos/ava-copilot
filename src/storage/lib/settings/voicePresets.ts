import { VOICE_MODEL_SIZES_MB } from './voiceEngineSettings';
import type {
  InstalledVoiceModels,
  LocalTtsEngineId,
  VoiceEngineSettings,
  VoiceModelId,
  VoiceTtsEngineId,
} from './voiceEngineSettings';
import { sttVerdict, ttsVerdict } from './voiceHealth';
import type { SpeedVerdict, VoiceHealth } from './voiceHealth';

/**
 * Voice presets: one choice that sets who hears and who speaks, with the files it needs and what it costs said
 * plainly. A preset whose files are not here says which to download first. Which one is recommended comes from what
 * was measured on this computer (voiceHealth), never from a guess at its hardware: an eight-core Apple chip runs
 * KittenTTS slower than speech in a browser, so cores say nothing.
 */

export type VoicePresetId = 'instant' | 'light' | 'natural' | 'cloud';

export interface VoicePreset {
  id: VoicePresetId;
  // The local files it needs
  models: VoiceModelId[];
  needsGeminiKey: boolean;
  // Audio leaves the computer (Gemini hears and speaks)
  leavesDevice: boolean;
  // The local engine that speaks, whose speed decides whether it keeps up
  localTts: LocalTtsEngineId | null;
  engine: Partial<VoiceEngineSettings>;
  tts: VoiceTtsEngineId;
}

const ON_DEVICE: Partial<VoiceEngineSettings> = {
  mode: 'economy',
  modeChosen: true,
  stt: 'moonshine',
  sttChosen: true,
  moonshineSize: 'tiny',
};

export const VOICE_PRESETS: readonly VoicePreset[] = [
  {
    // The computer's own voices cost nothing to make, so there is never a pause between sentences
    id: 'instant',
    models: ['moonshine-tiny'],
    needsGeminiKey: false,
    leavesDevice: false,
    localTts: null,
    engine: ON_DEVICE,
    tts: 'system',
  },
  {
    id: 'light',
    models: ['moonshine-tiny', 'kitten'],
    needsGeminiKey: false,
    leavesDevice: false,
    localTts: 'kitten',
    engine: ON_DEVICE,
    tts: 'kitten',
  },
  {
    id: 'natural',
    models: ['moonshine-base', 'kokoro'],
    needsGeminiKey: false,
    leavesDevice: false,
    localTts: 'kokoro',
    engine: { ...ON_DEVICE, moonshineSize: 'base' },
    tts: 'kokoro',
  },
  {
    id: 'cloud',
    models: [],
    needsGeminiKey: true,
    leavesDevice: true,
    localTts: null,
    engine: { mode: 'live', modeChosen: true, stt: 'gemini', sttChosen: true },
    tts: 'gemini',
  },
];

export const presetById = (id: VoicePresetId): VoicePreset => VOICE_PRESETS.find(preset => preset.id === id)!;

export interface PresetStatus {
  // The files still to download, and their size
  missing: VoiceModelId[];
  missingMb: number;
  needsKey: boolean;
  // It can be applied now
  available: boolean;
  // How its voice measured on this computer; 'unknown' when it was not (or it is not a local voice)
  speaking: SpeedVerdict;
  // Hearing too, when measured
  hearing: SpeedVerdict;
  // Its local voice makes speech slower than it plays on this computer: Ava would use the system voice for answers
  tooSlow: boolean;
}

export function presetStatus(
  preset: VoicePreset,
  context: { installed: InstalledVoiceModels; hasGeminiKey: boolean; health: Pick<VoiceHealth, 'tts' | 'stt'> },
): PresetStatus {
  const missing = preset.models.filter(id => !context.installed[id]);
  const needsKey = preset.needsGeminiKey && !context.hasGeminiKey;
  const speaking = preset.localTts ? ttsVerdict(context.health.tts[preset.localTts]?.speed) : 'unknown';
  const stt = preset.engine.stt;
  const hearing = stt && stt !== 'gemini' ? sttVerdict(context.health.stt[stt]?.speed) : 'unknown';
  return {
    missing,
    missingMb: missing.reduce((sum, id) => sum + VOICE_MODEL_SIZES_MB[id], 0),
    needsKey,
    available: missing.length === 0 && !needsKey,
    speaking,
    hearing,
    tooSlow: speaking === 'too-slow',
  };
}

export type Recommendation = {
  id: VoicePresetId;
  // Why, as a code the panel turns into a sentence
  reason: 'unchecked' | 'measured' | 'only-option' | 'hearing-slow';
};

/**
 * The preset to suggest: the most natural one that was measured to keep up, else the computer's own voice. Nothing
 * unmeasured is recommended over it, and the cloud only when listening on the device was measured too slow.
 */
export function recommendPreset(context: {
  installed: InstalledVoiceModels;
  hasGeminiKey: boolean;
  health: Pick<VoiceHealth, 'tts' | 'stt' | 'checkedAt'>;
}): Recommendation {
  const { health, installed } = context;
  const hearing = sttVerdict(health.stt.moonshine?.speed ?? health.stt.whisper?.speed);
  if (hearing === 'too-slow' && context.hasGeminiKey) return { id: 'cloud', reason: 'hearing-slow' };
  const keepsUp = (engine: LocalTtsEngineId) => {
    const verdict = ttsVerdict(health.tts[engine]?.speed);
    return installed[engine] && (verdict === 'fast' || verdict === 'steady');
  };
  if (keepsUp('kokoro')) return { id: 'natural', reason: 'measured' };
  if (keepsUp('kitten')) return { id: 'light', reason: 'measured' };
  return { id: 'instant', reason: health.checkedAt ? 'measured' : 'unchecked' };
}

/** What choosing a preset writes: the engine settings, and the engine that reads answers aloud. */
export function presetChanges(id: VoicePresetId): { engine: Partial<VoiceEngineSettings>; tts: VoiceTtsEngineId } {
  const preset = presetById(id);
  return { engine: preset.engine, tts: preset.tts };
}

/** The preset the settings match right now, if any: every setting it writes is as it would write it. */
export function activePreset(settings: VoiceEngineSettings, ttsEngine: VoiceTtsEngineId): VoicePresetId | null {
  const match = VOICE_PRESETS.find(
    preset =>
      preset.tts === ttsEngine &&
      (Object.entries(preset.engine) as [keyof VoiceEngineSettings, unknown][]).every(
        ([key, value]) => settings[key] === value,
      ),
  );
  return match?.id ?? null;
}
