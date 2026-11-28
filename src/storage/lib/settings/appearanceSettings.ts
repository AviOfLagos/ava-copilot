import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';
import { DEFAULT_APPEARANCE_SETTINGS, normalizeAppearance, stepTextScale } from './appearance';
import type { AppearanceSettingsConfig } from './appearance';

// The record and its pure functions live in ./appearance.ts, so the desktop app can use them without Chrome storage
export * from './appearance';

export type AppearanceSettingsStorage = BaseStorage<AppearanceSettingsConfig> & {
  updateSettings: (settings: Partial<AppearanceSettingsConfig>) => Promise<void>;
  getSettings: () => Promise<AppearanceSettingsConfig>;
  // Moves the text size one step and returns the new size
  stepText: (direction: 1 | -1) => Promise<number>;
  resetToDefaults: () => Promise<void>;
};

const storage = createStorage<AppearanceSettingsConfig>('appearance-settings', DEFAULT_APPEARANCE_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

// Writes run one after another, so two quick clicks (or two pages) never read the same old record
let writes: Promise<unknown> = Promise.resolve();
const serialized = <T>(task: () => Promise<T>): Promise<T> => {
  const next = writes.then(task, task);
  writes = next.catch(() => undefined);
  return next;
};

export const appearanceSettingsStore: AppearanceSettingsStorage = {
  ...storage,
  updateSettings: settings =>
    serialized(async () => {
      const current = normalizeAppearance(await storage.get());
      await storage.set(normalizeAppearance({ ...current, ...settings }));
    }),
  async getSettings() {
    return normalizeAppearance(await storage.get());
  },
  stepText: direction =>
    serialized(async () => {
      const current = normalizeAppearance(await storage.get());
      const textScale = stepTextScale(current.textScale, direction);
      if (textScale !== current.textScale) await storage.set({ ...current, textScale });
      return textScale;
    }),
  async resetToDefaults() {
    await serialized(() => storage.set(DEFAULT_APPEARANCE_SETTINGS));
  },
};
