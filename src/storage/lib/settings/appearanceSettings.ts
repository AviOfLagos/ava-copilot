import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

/**
 * How Ava looks: theme, text size and spacing. Plain data plus pure functions, so the side panel, the settings
 * page and the planned Ava desktop app all read the same record and turn it into the same CSS (see
 * docs/appearance.md). Nothing here touches the DOM.
 */

export type ThemeChoice = 'dark' | 'light' | 'system';
export type Density = 'compact' | 'comfortable' | 'roomy';

export interface AppearanceSettingsConfig {
  theme: ThemeChoice;
  // Percent of the normal size; always one of TEXT_SCALES
  textScale: number;
  density: Density;
}

export const THEME_CHOICES: readonly ThemeChoice[] = ['dark', 'light', 'system'];
export const DENSITIES: readonly Density[] = ['compact', 'comfortable', 'roomy'];
// The steps of the text size, in percent. The A−/A+ buttons move one step at a time.
export const TEXT_SCALES: readonly number[] = [85, 90, 100, 110, 120, 130];

// How much the spacing scale (padding, gaps, control sizes) is multiplied by
export const DENSITY_FACTORS: Record<Density, number> = { compact: 0.85, comfortable: 1, roomy: 1.15 };

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettingsConfig = {
  // Dark has always been the panel's look until a person chooses otherwise
  theme: 'dark',
  textScale: 100,
  density: 'comfortable',
};

/** The step nearest to a percent; anything that is not a number is the normal size. */
export function nearestTextScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 100;
  return TEXT_SCALES.reduce((best, step) => (Math.abs(step - value) < Math.abs(best - value) ? step : best));
}

/** One step up or down, stopping at the ends. */
export function stepTextScale(current: number, direction: 1 | -1): number {
  const index = TEXT_SCALES.indexOf(nearestTextScale(current));
  return TEXT_SCALES[Math.min(TEXT_SCALES.length - 1, Math.max(0, index + direction))];
}

/** Whatever was stored (older versions, hand edits, another device) turned into a valid record. */
export function normalizeAppearance(value: unknown): AppearanceSettingsConfig {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<
    Record<keyof AppearanceSettingsConfig, unknown>
  >;
  return {
    theme: THEME_CHOICES.includes(raw.theme as ThemeChoice)
      ? (raw.theme as ThemeChoice)
      : DEFAULT_APPEARANCE_SETTINGS.theme,
    textScale: raw.textScale === undefined ? DEFAULT_APPEARANCE_SETTINGS.textScale : nearestTextScale(raw.textScale),
    density: DENSITIES.includes(raw.density as Density)
      ? (raw.density as Density)
      : DEFAULT_APPEARANCE_SETTINGS.density,
  };
}

/** Light or dark, given what the system prefers. */
export function resolveTheme(theme: ThemeChoice, systemDark: boolean): 'dark' | 'light' {
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
}

/**
 * The values a page puts on its root element. `zoom` scales everything (text, icons, borders, the many fixed pixel
 * sizes); `--density` is read by the Tailwind spacing scale (src/ui/lib/density.ts).
 */
export function appearanceCss(settings: AppearanceSettingsConfig, systemDark: boolean) {
  return {
    theme: resolveTheme(settings.theme, systemDark),
    zoom: String(settings.textScale / 100),
    density: String(DENSITY_FACTORS[settings.density]),
  };
}

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

export const appearanceSettingsStore: AppearanceSettingsStorage = {
  ...storage,
  async updateSettings(settings) {
    const current = normalizeAppearance(await storage.get());
    await storage.set(normalizeAppearance({ ...current, ...settings }));
  },
  async getSettings() {
    return normalizeAppearance(await storage.get());
  },
  async stepText(direction) {
    const current = normalizeAppearance(await storage.get());
    const textScale = stepTextScale(current.textScale, direction);
    if (textScale !== current.textScale) await storage.set({ ...current, textScale });
    return textScale;
  },
  async resetToDefaults() {
    await storage.set(DEFAULT_APPEARANCE_SETTINGS);
  },
};
