import { useEffect, useLayoutEffect, useState } from 'react';
import {
  appearanceCss,
  appearanceSettingsStore,
  DEFAULT_APPEARANCE_SETTINGS,
  normalizeAppearance,
} from '@extension/storage';
import type { AppearanceSettingsConfig, ThemeChoice } from '@extension/storage';

export type { ThemeChoice };

// The last record, kept in this page's localStorage so a page paints with the right size and theme straight away
// instead of flashing the defaults while storage.local answers. The record in storage.local is the truth.
const CACHE_KEY = 'avi-copilot-appearance';
// What the panel stored before appearance settings existed: the theme alone
const OLD_THEME_KEY = 'avi-copilot-theme';

function readCache(): AppearanceSettingsConfig {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) return normalizeAppearance(JSON.parse(cached));
    const old = localStorage.getItem(OLD_THEME_KEY);
    if (old) return normalizeAppearance({ theme: old });
  } catch {
    // Not readable: the defaults
  }
  return DEFAULT_APPEARANCE_SETTINGS;
}

function writeCache(settings: AppearanceSettingsConfig) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(settings));
  } catch {
    // It only means the next open flashes the defaults first
  }
}

/** Puts the look on the page: theme, text size (root zoom) and spacing density. */
export function applyAppearance(settings: AppearanceSettingsConfig, systemDark: boolean) {
  const css = appearanceCss(settings, systemDark);
  const root = document.documentElement;
  root.dataset.theme = css.theme;
  root.style.setProperty('--density', css.density);
  root.style.setProperty('--ui-zoom', css.zoom);
  root.style.setProperty('zoom', css.zoom);
}

/** Saves the choice for every page (and, later, the desktop app); each page applies it live. */
export function saveTheme(choice: ThemeChoice) {
  void appearanceSettingsStore.updateSettings({ theme: choice });
}

/**
 * Applies the saved look to this page and keeps it in step with changes made anywhere else, with no reload.
 * Returns the whole record and whether the page is dark.
 */
export function useAppearance(): { settings: AppearanceSettingsConfig; dark: boolean } {
  const [settings, setSettings] = useState<AppearanceSettingsConfig>(readCache);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void appearanceSettingsStore.getSettings().then(next => {
        if (!alive) return;
        writeCache(next);
        setSettings(next);
      });
    load();
    const stop = appearanceSettingsStore.subscribe(load);
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystem = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', onSystem);
    return () => {
      alive = false;
      stop();
      query.removeEventListener('change', onSystem);
    };
  }, []);

  useLayoutEffect(() => {
    applyAppearance(settings, systemDark);
  }, [settings, systemDark]);

  return { settings, dark: appearanceCss(settings, systemDark).theme === 'dark' };
}

/** The theme part of the look, for pages that only care about that. Applies the whole look too. */
export function useTheme(): { choice: ThemeChoice; dark: boolean } {
  const { settings, dark } = useAppearance();
  return { choice: settings.theme, dark };
}
