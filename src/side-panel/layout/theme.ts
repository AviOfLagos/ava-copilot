import { useEffect, useState } from 'react';

export type ThemeChoice = 'dark' | 'light' | 'system';

const KEY = 'avi-copilot-theme';

export function readTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'system' ? value : 'dark';
  } catch {
    return 'dark';
  }
}

export function saveTheme(choice: ThemeChoice) {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // The choice simply is not remembered
  }
  window.dispatchEvent(new CustomEvent('avi-theme', { detail: choice }));
}

/**
 * Applies the chosen look to the page (dark unless chosen otherwise) and returns whether it is dark.
 * The choice lives in this browser only: it is a per-person convenience.
 */
export function useTheme(): { choice: ThemeChoice; dark: boolean } {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystem = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    const onChoice = (event: Event) => setChoice((event as CustomEvent<ThemeChoice>).detail);
    const onStorage = (event: StorageEvent) => event.key === KEY && setChoice(readTheme());
    query.addEventListener('change', onSystem);
    window.addEventListener('avi-theme', onChoice);
    window.addEventListener('storage', onStorage);
    return () => {
      query.removeEventListener('change', onSystem);
      window.removeEventListener('avi-theme', onChoice);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const dark = choice === 'dark' || (choice === 'system' && systemDark);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  return { choice, dark };
}
