import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

// When answers are read aloud without being asked: never, only after the user spoke, or always
export type ReadAloudMode = 'off' | 'voice' | 'always';

// Which engine speaks: the operating system's voices (free, offline, the default) or Gemini's cloud voices
export type TtsEngineId = 'system' | 'gemini' | 'kitten' | 'kokoro';

export interface TtsSettingsConfig {
  readAloud: ReadAloudMode;
  engine: TtsEngineId;
  // A voice name from the chosen engine; '' uses its default
  voice: string;
  // Speaking rate; 1 is normal speed
  rate: number;
  // The last answer read aloud on its own, so a run that settles twice never speaks it twice
  lastSpokenMessageId: string | null;
}

export const DEFAULT_TTS_SETTINGS: TtsSettingsConfig = {
  readAloud: 'voice',
  engine: 'system',
  voice: '',
  rate: 1,
  lastSpokenMessageId: null,
};

export type TtsSettingsStorage = BaseStorage<TtsSettingsConfig> & {
  getSettings: () => Promise<TtsSettingsConfig>;
  updateSettings: (changes: Partial<TtsSettingsConfig>) => Promise<void>;
};

const storage = createStorage<TtsSettingsConfig>('tts-settings', DEFAULT_TTS_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const ttsSettingsStore: TtsSettingsStorage = {
  ...storage,
  async getSettings() {
    return { ...DEFAULT_TTS_SETTINGS, ...(await storage.get()) };
  },
  async updateSettings(changes) {
    await storage.set({ ...(await ttsSettingsStore.getSettings()), ...changes });
  },
};

// Who is speaking right now, if anyone. The background sets this the instant it starts or stops, so
// every open panel shows the same Speak/Stop state without asking. Session storage: a cold start of
// the background means nothing is speaking yet, which is the correct answer.
export interface TtsSpeakingState {
  threadId: string | null;
  messageId: string | null;
}

export const EMPTY_SPEAKING: TtsSpeakingState = { threadId: null, messageId: null };

let speaking: BaseStorage<TtsSpeakingState> | null = null;

/**
 * What is being read aloud right now, in session storage (it must not outlive the browser). Made on
 * first use, not on import: pages and tests that only read settings never touch session storage.
 */
function speakingStore(): BaseStorage<TtsSpeakingState> {
  speaking ??= createStorage<TtsSpeakingState>('tts-speaking', EMPTY_SPEAKING, {
    storageEnum: StorageEnum.Session,
    liveUpdate: true,
  });
  return speaking;
}

export const ttsSpeakingStore: BaseStorage<TtsSpeakingState> = {
  get: () => speakingStore().get(),
  set: value => speakingStore().set(value),
  getSnapshot: () => speakingStore().getSnapshot(),
  subscribe: listener => speakingStore().subscribe(listener),
};
