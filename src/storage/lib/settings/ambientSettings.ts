import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

/**
 * Settings › Ambient (docs/ambient-plan.md). Off: Ava only hears the wake word, if it is on. Listen: she writes
 * down what is said around her, on this Mac, and never answers unless the wake word starts a conversation.
 * Companion: the same until the speak gate (A4) lets her nudge and chime in.
 */

export type AmbientMode = 'off' | 'listen' | 'companion';

export interface AmbientSettingsConfig {
  mode: AmbientMode;
  // "Off the record": nothing is written down until "back on the record" or the switch in the panel
  offRecord: boolean;
  // When off the record started, for the indicator
  offRecordSince: number | null;
  // What Ava hears may reach a cloud model (to compose a line, seed a conversation, or be searched and embedded
  // with the rest of the knowledge base). Off by default: ambient text then never leaves this Mac
  cloudAllowed: boolean;
}

export const DEFAULT_AMBIENT_SETTINGS: AmbientSettingsConfig = {
  mode: 'off',
  offRecord: false,
  offRecordSince: null,
  cloudAllowed: false,
};

export type AmbientSettingsStorage = BaseStorage<AmbientSettingsConfig> & {
  getSettings: () => Promise<AmbientSettingsConfig>;
  updateSettings: (changes: Partial<AmbientSettingsConfig>) => Promise<void>;
};

const storage = createStorage<AmbientSettingsConfig>('ambient-settings', DEFAULT_AMBIENT_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const ambientSettingsStore: AmbientSettingsStorage = {
  ...storage,
  async getSettings() {
    return { ...DEFAULT_AMBIENT_SETTINGS, ...(await storage.get()) };
  },
  async updateSettings(changes) {
    await storage.set({ ...(await ambientSettingsStore.getSettings()), ...changes });
  },
};

/** Whether the scribe writes anything down with these settings. */
export function ambientTranscribing(settings: Pick<AmbientSettingsConfig, 'mode' | 'offRecord'>): boolean {
  return settings.mode !== 'off' && !settings.offRecord;
}
