import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

/**
 * How the Inbox speaks up and reads tabs the user already has open. Tab watchers are off by default
 * (reading a WhatsApp/Slack/Gmail tab is more sensitive than anything else here); speaking up is on by
 * default, since it is one of the things Avi asked this wave to add.
 */
export interface InboxSettingsConfig {
  // "Speak up when something needs me"
  speakUp: boolean;
  // Quiet hours as "HH:MM" local 24h time; null means no quiet hours. Wraps past midnight when
  // end < start (e.g. 22:00 to 07:00).
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  watchWhatsapp: boolean;
  watchSlack: boolean;
  watchGmail: boolean;
}

export const DEFAULT_INBOX_SETTINGS: InboxSettingsConfig = {
  speakUp: true,
  quietHoursStart: null,
  quietHoursEnd: null,
  watchWhatsapp: false,
  watchSlack: false,
  watchGmail: false,
};

export type InboxSettingsStorage = BaseStorage<InboxSettingsConfig> & {
  getSettings: () => Promise<InboxSettingsConfig>;
  updateSettings: (changes: Partial<InboxSettingsConfig>) => Promise<void>;
};

const storage = createStorage<InboxSettingsConfig>('inbox-settings', DEFAULT_INBOX_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const inboxSettingsStore: InboxSettingsStorage = {
  ...storage,
  async getSettings() {
    return { ...DEFAULT_INBOX_SETTINGS, ...(await storage.get()) };
  },
  async updateSettings(changes) {
    await storage.set({ ...(await inboxSettingsStore.getSettings()), ...changes });
  },
};
