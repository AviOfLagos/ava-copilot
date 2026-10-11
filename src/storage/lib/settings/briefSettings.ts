import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

export interface BriefSettingsConfig {
  // A brief every morning, unasked
  enabled: boolean;
  // When it comes, in local time
  hour: number;
  minute: number;
  // The last day a brief was made, "YYYY-MM-DD", so it comes once a day
  lastDay: string;
  // The chat that holds the latest brief
  lastThreadId: string | null;
}

export const DEFAULT_BRIEF_SETTINGS: BriefSettingsConfig = {
  enabled: true,
  hour: 8,
  minute: 0,
  lastDay: '',
  lastThreadId: null,
};

export type BriefSettingsStorage = BaseStorage<BriefSettingsConfig> & {
  getSettings: () => Promise<BriefSettingsConfig>;
  updateSettings: (changes: Partial<BriefSettingsConfig>) => Promise<void>;
};

const storage = createStorage<BriefSettingsConfig>('brief-settings', DEFAULT_BRIEF_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const briefSettingsStore: BriefSettingsStorage = {
  ...storage,
  async getSettings() {
    return { ...DEFAULT_BRIEF_SETTINGS, ...(await storage.get()) };
  },
  async updateSettings(changes) {
    await storage.set({ ...(await briefSettingsStore.getSettings()), ...changes });
  },
};
