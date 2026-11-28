import { appearanceCss, DEFAULT_APPEARANCE_SETTINGS, normalizeAppearance } from '@appearance';
import type { AppearanceSettingsConfig } from '@appearance';

// The last record, so the window paints right before the main process answers (as the panel does)
const CACHE_KEY = 'ava-appearance';

export function cachedAppearance(): AppearanceSettingsConfig {
  try {
    return normalizeAppearance(JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null'));
  } catch {
    return DEFAULT_APPEARANCE_SETTINGS;
  }
}

/** The same three values as the side panel: data-theme, root zoom, --density (docs/appearance.md). */
export function applyAppearance(settings: AppearanceSettingsConfig, systemDark: boolean): void {
  const css = appearanceCss(settings, systemDark);
  const root = document.documentElement;
  root.dataset.theme = css.theme;
  root.style.setProperty('zoom', css.zoom);
  root.style.setProperty('--ui-zoom', css.zoom);
  root.style.setProperty('--density', css.density);
  localStorage.setItem(CACHE_KEY, JSON.stringify(settings));
}
