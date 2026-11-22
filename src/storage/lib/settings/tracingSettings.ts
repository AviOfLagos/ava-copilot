import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

/**
 * Settings › Privacy › Hosted tracing. Off by default: planner and navigator calls go to the hosted Suture project
 * only when this switch is on AND the build carries an ingest key (VITE_SUTURE_API_KEY). The text of prompts and
 * replies is a second, separate switch, because chats include what strangers send on WhatsApp.
 */
export interface TracingSettingsConfig {
  hostedEnabled: boolean;
  // Also send the prompt and reply text, not only timings, model and token counts
  captureContent: boolean;
}

export const DEFAULT_TRACING_SETTINGS: TracingSettingsConfig = {
  hostedEnabled: false,
  captureContent: false,
};

export type TracingSettingsStorage = BaseStorage<TracingSettingsConfig> & {
  getSettings: () => Promise<TracingSettingsConfig>;
  updateSettings: (changes: Partial<TracingSettingsConfig>) => Promise<void>;
};

const storage = createStorage<TracingSettingsConfig>('tracing-settings', DEFAULT_TRACING_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const tracingSettingsStore: TracingSettingsStorage = {
  ...storage,
  async getSettings() {
    return { ...DEFAULT_TRACING_SETTINGS, ...(await storage.get()) };
  },
  async updateSettings(changes) {
    await storage.set({ ...(await tracingSettingsStore.getSettings()), ...changes });
  },
};
