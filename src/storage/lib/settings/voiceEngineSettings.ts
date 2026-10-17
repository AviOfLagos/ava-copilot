import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';
import { ttsSettingsStore } from './ttsSettings';
import type { TtsSettingsConfig } from './ttsSettings';

/**
 * Settings › Voice engines: which engines hear and speak, and whether a conversation runs on Gemini Live (audio
 * to the cloud) or in economy mode (speech recognised on the device, a text model answers, a local voice speaks).
 * The model files are downloaded on first use (`@extension/shared` voice-models), or packed into a dev build by
 * `node scripts/voice-models-setup.mjs`.
 */

// Live: Gemini hears, thinks and speaks. Economy: audio never leaves the device; only text goes to a model.
// Auto (the default): economy whenever the on-device speech files are there, so talking needs no key; Gemini Live
// only when they are not and a Gemini key is. Live is used first only when the user picked it (see resolveVoiceMode)
export type VoiceMode = 'auto' | 'live' | 'economy';

// Who turns speech into text. Gemini only in a Live conversation; the others run on the device
export type SttEngineId = 'gemini' | 'moonshine' | 'whisper' | 'vosk';
export type LocalSttEngineId = Exclude<SttEngineId, 'gemini'>;

// Who speaks. `system` and `gemini` are WS2's engines; `kitten` and `kokoro` run on the device
export type VoiceTtsEngineId = 'system' | 'kitten' | 'kokoro' | 'gemini';
export type LocalTtsEngineId = 'kitten' | 'kokoro';

export type MoonshineSize = 'tiny' | 'base';

// The text model an economy conversation uses: the quick model, or a model running on this Mac
export type EconomyModelRole = 'fast' | 'local';

export interface VoiceEngineSettings {
  mode: VoiceMode;
  // The user picked the mode in Settings › Voice engines (an older stored "live" may just be the old default)
  modeChosen: boolean;
  stt: SttEngineId;
  moonshineSize: MoonshineSize;
  // Recognise speech on the graphics card (WebGPU) when its weights are installed; else on the processor
  sttGpu: boolean;
  kittenVoice: string;
  kokoroVoice: string;
  economyModel: EconomyModelRole;
  // A conversation with nothing said and no task running for this long ends by itself; 0 never
  idleEndMinutes: number;
}

export const KITTEN_VOICES = ['Bella', 'Jasper', 'Luna', 'Bruno', 'Rosie', 'Hugo', 'Kiki', 'Leo'] as const;
export const KOKORO_VOICES = [
  'af_heart',
  'af_bella',
  'af_nicole',
  'af_sarah',
  'am_michael',
  'am_fenrir',
  'bf_emma',
  'bm_george',
] as const;

export const DEFAULT_VOICE_ENGINE_SETTINGS: VoiceEngineSettings = {
  mode: 'auto',
  modeChosen: false,
  stt: 'moonshine',
  moonshineSize: 'tiny',
  sttGpu: true,
  kittenVoice: 'Bella',
  kokoroVoice: 'af_heart',
  economyModel: 'fast',
  idleEndMinutes: 3,
};

/**
 * What a conversation runs on now. Economy needs no key; Live needs a Gemini key and is used first only when the
 * user picked it. Auto prefers the device and falls back to Live only when the speech files are missing and a key is
 * there. Without either, economy is answered, and starting it says plainly which files are missing.
 */
export function resolveVoiceMode(
  settings: Pick<VoiceEngineSettings, 'mode'>,
  { hasGeminiKey, localReady }: { hasGeminiKey: boolean; localReady: boolean },
): 'live' | 'economy' {
  if (settings.mode === 'economy') return 'economy';
  if (settings.mode === 'live') return hasGeminiKey ? 'live' : 'economy';
  return !localReady && hasGeminiKey ? 'live' : 'economy';
}

/**
 * Stored settings as they are meant now. Before 'auto' existed every save wrote the default 'live', so a stored
 * 'live' the user never picked (no `modeChosen`) is the old default and becomes 'auto'; 'economy' was always a
 * choice and stays. A mode picked in Settings carries `modeChosen` and is kept as it is.
 */
export function migrateVoiceEngineSettings(
  stored: Partial<VoiceEngineSettings> | null | undefined,
): VoiceEngineSettings {
  const merged = { ...DEFAULT_VOICE_ENGINE_SETTINGS, ...(stored ?? {}) };
  if (!stored?.modeChosen) {
    if (merged.mode === 'live') merged.mode = 'auto';
    merged.modeChosen = merged.mode === 'economy';
  }
  if (!['auto', 'live', 'economy'].includes(merged.mode)) merged.mode = 'auto';
  return merged;
}

/** The local voice models (downloaded on first use, or packed by the setup scripts), and the wake word's Vosk model. */
export type VoiceModelId = 'kitten' | 'kokoro' | 'moonshine-tiny' | 'moonshine-base' | 'whisper-base' | 'vosk';

export interface InstalledVoiceModel {
  bytes: number;
  // Moonshine's float weights for the GPU are there too
  webgpu?: boolean;
  // Downloaded on first use into the extension's own storage, rather than packed into the build
  downloaded?: boolean;
}

export type InstalledVoiceModels = Partial<Record<VoiceModelId, InstalledVoiceModel>>;

// Download sizes, for Settings to show before anything is installed
export const VOICE_MODEL_SIZES_MB: Record<VoiceModelId, number> = {
  kitten: 28,
  kokoro: 97,
  'moonshine-tiny': 32,
  'moonshine-base': 67,
  'whisper-base': 80,
  vosk: 41,
};

const LOCAL_STT: LocalSttEngineId[] = ['moonshine', 'whisper', 'vosk'];
const TTS_ENGINES: VoiceTtsEngineId[] = ['system', 'kitten', 'kokoro', 'gemini'];

/** The model folder a local speech-to-text engine needs. */
export function sttModelId(engine: LocalSttEngineId, moonshineSize: MoonshineSize): VoiceModelId {
  if (engine === 'moonshine') return moonshineSize === 'base' ? 'moonshine-base' : 'moonshine-tiny';
  return engine === 'whisper' ? 'whisper-base' : 'vosk';
}

export interface SttChoice {
  engine: LocalSttEngineId;
  // The model folder (Moonshine and Whisper; Vosk uses the wake word's)
  model?: 'moonshine-tiny' | 'moonshine-base' | 'whisper-base';
  // Run on the graphics card: allowed in settings and its weights installed
  webgpu: boolean;
}

/** The local recogniser to use, with its model folder and device; null when none is installed. */
export function localSttChoice(settings: VoiceEngineSettings, installed: InstalledVoiceModels): SttChoice | null {
  const engine = economyStt(settings, installed);
  if (!engine) return null;
  if (engine === 'vosk') return { engine, webgpu: false };
  let model = sttModelId(engine, settings.moonshineSize) as NonNullable<SttChoice['model']>;
  // The chosen Moonshine size is not installed but the other one is
  if (engine === 'moonshine' && !installed[model]) {
    model = installed['moonshine-tiny'] ? 'moonshine-tiny' : 'moonshine-base';
  }
  return { engine, model, webgpu: settings.sttGpu && Boolean(installed[model]?.webgpu) };
}

/**
 * Who hears in an economy conversation: the engine chosen when it is local and installed, else the first local
 * engine installed (Moonshine, then Whisper, then Vosk); null when none is.
 */
export function economyStt(settings: VoiceEngineSettings, installed: InstalledVoiceModels): LocalSttEngineId | null {
  const has = (engine: LocalSttEngineId) => Boolean(installed[sttModelId(engine, settings.moonshineSize)]);
  if (settings.stt !== 'gemini' && has(settings.stt)) return settings.stt;
  // The chosen size of Moonshine is missing but the other is there
  if (settings.stt === 'moonshine' && (installed['moonshine-tiny'] || installed['moonshine-base'])) return 'moonshine';
  return LOCAL_STT.find(has) ?? null;
}

/**
 * Who speaks in an economy conversation: a local voice chosen and installed, else KittenTTS when installed, else
 * the system's voices. Never Gemini: economy mode sends nothing to a paid voice.
 */
export function economyTts(
  engine: VoiceTtsEngineId,
  installed: InstalledVoiceModels,
  // The user picked this engine (the system voices are also the untouched default, which a conversation improves on)
  chosen = true,
): 'kitten' | 'kokoro' | 'system' {
  if ((engine === 'kitten' || engine === 'kokoro') && installed[engine]) return engine;
  if (engine === 'system' && chosen) return 'system';
  return installed.kitten ? 'kitten' : 'system';
}

/** A stored engine name, checked: anything unknown is the system's voices. */
export function voiceTtsEngine(value: unknown): VoiceTtsEngineId {
  return TTS_ENGINES.includes(value as VoiceTtsEngineId) ? (value as VoiceTtsEngineId) : 'system';
}

/** The voice to use with a local engine: the one chosen when it is one of the engine's. */
export function localVoice(engine: LocalTtsEngineId, settings: VoiceEngineSettings): string {
  if (engine === 'kokoro') {
    return (KOKORO_VOICES as readonly string[]).includes(settings.kokoroVoice) ? settings.kokoroVoice : 'af_heart';
  }
  return (KITTEN_VOICES as readonly string[]).includes(settings.kittenVoice) ? settings.kittenVoice : 'Bella';
}

export type VoiceEngineSettingsStorage = BaseStorage<VoiceEngineSettings> & {
  getSettings: () => Promise<VoiceEngineSettings>;
  updateSettings: (changes: Partial<VoiceEngineSettings>) => Promise<void>;
  /** The engine answers are spoken with: the one setting shared with Settings › Voice output. */
  getTtsEngine: () => Promise<VoiceTtsEngineId>;
  setTtsEngine: (engine: VoiceTtsEngineId) => Promise<void>;
};

const storage = createStorage<VoiceEngineSettings>('voice-engine-settings', DEFAULT_VOICE_ENGINE_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const voiceEngineSettingsStore: VoiceEngineSettingsStorage = {
  ...storage,
  async getSettings() {
    return migrateVoiceEngineSettings(await storage.get());
  },
  async updateSettings(changes) {
    await storage.set({ ...(await voiceEngineSettingsStore.getSettings()), ...changes });
  },
  async getTtsEngine() {
    return voiceTtsEngine((await ttsSettingsStore.getSettings()).engine);
  },
  async setTtsEngine(engine) {
    const current = await ttsSettingsStore.getSettings();
    // TtsEngineId in ttsSettings.ts lists only WS2's two engines until it is widened to VoiceTtsEngineId
    await ttsSettingsStore.set({ ...current, engine, engineChosen: true } as unknown as TtsSettingsConfig);
  },
};
