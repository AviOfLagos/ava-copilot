import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';
import { ttsSettingsStore } from './ttsSettings';
import type { TtsSettingsConfig } from './ttsSettings';

/**
 * Settings › Voice engines: which engines hear and speak, and whether a conversation runs on Gemini Live (audio
 * to the cloud) or in economy mode (speech recognised on the device, a text model answers, a local voice speaks).
 * The model files come from `node scripts/voice-models-setup.mjs` into the extension's own `voice/` folder.
 */

// Live: Gemini hears, thinks and speaks. Economy: audio never leaves the device; only text goes to a model
export type VoiceMode = 'live' | 'economy';

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
  mode: 'live',
  stt: 'gemini',
  moonshineSize: 'tiny',
  sttGpu: true,
  kittenVoice: 'Bella',
  kokoroVoice: 'af_heart',
  economyModel: 'fast',
  idleEndMinutes: 3,
};

/** The model folders `scripts/voice-models-setup.mjs` can install, and the wake word's Vosk model. */
export type VoiceModelId = 'kitten' | 'kokoro' | 'moonshine-tiny' | 'moonshine-base' | 'whisper-base' | 'vosk';

export interface InstalledVoiceModel {
  bytes: number;
  // Moonshine's float weights for the GPU are there too
  webgpu?: boolean;
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
export function economyTts(engine: VoiceTtsEngineId, installed: InstalledVoiceModels): 'kitten' | 'kokoro' | 'system' {
  if ((engine === 'kitten' || engine === 'kokoro') && installed[engine]) return engine;
  if (engine === 'system') return 'system';
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
    return { ...DEFAULT_VOICE_ENGINE_SETTINGS, ...(await storage.get()) };
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
    await ttsSettingsStore.set({ ...current, engine } as unknown as TtsSettingsConfig);
  },
};
