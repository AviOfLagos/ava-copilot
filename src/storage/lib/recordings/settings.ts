import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

export interface RecordingSettingsConfig {
  // A screen recording stops by itself after this many minutes
  maxMinutes: number;
  // Whether the Inbox was already told once that Drive is not connected
  driveNudged: boolean;
}

export const DEFAULT_RECORDING_SETTINGS: RecordingSettingsConfig = { maxMinutes: 10, driveNudged: false };

export const RECORDING_MAX_MINUTES = { min: 1, max: 60 };

// Two minutes with nothing heard stops a recording
export const RECORDING_SILENCE_MS = 2 * 60_000;

export type RecordingSettingsStorage = BaseStorage<RecordingSettingsConfig> & {
  getSettings: () => Promise<RecordingSettingsConfig>;
  updateSettings: (changes: Partial<RecordingSettingsConfig>) => Promise<void>;
};

const storage = createStorage<RecordingSettingsConfig>('recording-settings', DEFAULT_RECORDING_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

const clampMinutes = (value: number) =>
  Number.isFinite(value)
    ? Math.min(RECORDING_MAX_MINUTES.max, Math.max(RECORDING_MAX_MINUTES.min, Math.round(value)))
    : DEFAULT_RECORDING_SETTINGS.maxMinutes;

export const recordingSettingsStore: RecordingSettingsStorage = {
  ...storage,
  async getSettings() {
    const kept = { ...DEFAULT_RECORDING_SETTINGS, ...(await storage.get()) };
    return { ...kept, maxMinutes: clampMinutes(kept.maxMinutes) };
  },
  async updateSettings(changes) {
    const next = { ...(await recordingSettingsStore.getSettings()), ...changes };
    await storage.set({ ...next, maxMinutes: clampMinutes(next.maxMinutes) });
  },
};
