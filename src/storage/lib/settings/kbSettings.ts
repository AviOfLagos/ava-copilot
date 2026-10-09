import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

export interface KbSettingsConfig {
  // Add chats and meeting notes to the knowledge base on their own; saved pages are always added
  indexChats: boolean;
  indexMeetings: boolean;
  // Remove items older than this many days; 0 keeps everything
  retentionDays: number;
  embedModel: string;
  embedDimensions: number;
  // Where embeddings come from: Gemini, a local Ollama server, or Gemini when there is a key and Ollama otherwise
  embedSource: 'auto' | 'gemini' | 'local';
  // The Ollama embedding model for local search
  localEmbedModel: string;
}

export const DEFAULT_KB_SETTINGS: KbSettingsConfig = {
  indexChats: true,
  indexMeetings: true,
  retentionDays: 0,
  embedModel: 'gemini-embedding-2',
  embedDimensions: 768,
  embedSource: 'auto',
  localEmbedModel: 'nomic-embed-text',
};

export type KbSettingsStorage = BaseStorage<KbSettingsConfig> & {
  getSettings: () => Promise<KbSettingsConfig>;
  updateSettings: (changes: Partial<KbSettingsConfig>) => Promise<void>;
};

const storage = createStorage<KbSettingsConfig>('kb-settings', DEFAULT_KB_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const kbSettingsStore: KbSettingsStorage = {
  ...storage,
  async getSettings() {
    return { ...DEFAULT_KB_SETTINGS, ...(await storage.get()) };
  },
  async updateSettings(changes) {
    await storage.set({ ...(await kbSettingsStore.getSettings()), ...changes });
  },
};
