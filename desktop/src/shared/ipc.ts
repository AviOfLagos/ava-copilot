import type { AppearanceSettingsConfig } from '@appearance';
import type { DesktopReply } from '@protocol';

/** What the window may ask the main process for (src/main/preload.ts exposes exactly these as `window.ava`). */

export type BrainView =
  | { state: 'off'; message: string }
  | {
      state: 'on';
      version: string;
      browserOpen: boolean;
      whatsapp: string;
      queued: number;
    };

export interface AvaBridge {
  brainStatus: () => Promise<BrainView>;
  // The chat's words, sent to Ava Brain; false when Ava Brain could not take them
  send: (chatId: string, text: string) => Promise<{ ok: boolean; message?: string }>;
  // Answers after `after`; `restarted` when Ava Brain started again and numbers them from 1
  replies: (after: number) => Promise<{ replies: DesktopReply[]; restarted: boolean }>;
  // Where answers start for a window that just opened; null while Ava Brain cannot be asked
  startSeq: () => Promise<number | null>;
  appearance: () => Promise<AppearanceSettingsConfig>;
  setAppearance: (changes: Partial<AppearanceSettingsConfig>) => Promise<AppearanceSettingsConfig>;
  // Whether macOS is in dark mode now
  systemDark: () => Promise<boolean>;
  onSystemTheme: (listener: (dark: boolean) => void) => () => void;
}

export const IPC = {
  brainStatus: 'ava:brain-status',
  send: 'ava:send',
  replies: 'ava:replies',
  startSeq: 'ava:start-seq',
  appearance: 'ava:appearance',
  setAppearance: 'ava:set-appearance',
  systemDark: 'ava:system-dark',
  systemTheme: 'ava:system-theme',
} as const;
