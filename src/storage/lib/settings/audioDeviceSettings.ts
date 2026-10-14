import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

// What was chosen for a microphone or speaker: `null` is "System default". Kept by deviceId with its
// label, because deviceIds are reassigned between sessions but a real device's label does not change
// (see src/shared/lib/audio-devices, which matches a choice like this against the devices seen now).
export interface AudioDeviceChoice {
  deviceId: string;
  label: string;
}

export interface AudioDeviceSettingsConfig {
  mic: AudioDeviceChoice | null;
  speaker: AudioDeviceChoice | null;
}

export const DEFAULT_AUDIO_DEVICE_SETTINGS: AudioDeviceSettingsConfig = {
  mic: null,
  speaker: null,
};

export type AudioDeviceSettingsStorage = BaseStorage<AudioDeviceSettingsConfig> & {
  getSettings: () => Promise<AudioDeviceSettingsConfig>;
  updateSettings: (changes: Partial<AudioDeviceSettingsConfig>) => Promise<void>;
};

const storage = createStorage<AudioDeviceSettingsConfig>('audio-device-settings', DEFAULT_AUDIO_DEVICE_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const audioDeviceSettingsStore: AudioDeviceSettingsStorage = {
  ...storage,
  async getSettings() {
    return { ...DEFAULT_AUDIO_DEVICE_SETTINGS, ...(await storage.get()) };
  },
  async updateSettings(changes) {
    await storage.set({ ...(await audioDeviceSettingsStore.getSettings()), ...changes });
  },
};
