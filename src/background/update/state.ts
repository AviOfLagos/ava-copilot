import { createStorage } from '@extension/storage/lib/base/base';
import { StorageEnum } from '@extension/storage/lib/base/enums';
import type { VersionInfo } from './schema';

/**
 * What the extension knows about updates: whether to look (a setting, shown on Settings › Help), and what the
 * last check found (for the banner, the Settings section, the toolbar tooltip, and "only notify once per
 * version"). The background is the only writer; pages read these stores directly, the same way Ava Brain's
 * settings and status do (src/background/companion/state.ts).
 */

export interface UpdateSettings {
  // Whether the periodic and at-start checks run at all; "Check now" always works regardless
  checkEnabled: boolean;
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = { checkEnabled: true };

export interface UpdateStatus {
  checkedAt: number | null;
  // A plain sentence when the last check failed; cleared on the next successful one
  error: string | null;
  // The last feed that validated, kept even if a later check fails, so the banner does not flicker off
  info: VersionInfo | null;
  extensionUpdateAvailable: boolean;
  brainUpdateAvailable: boolean;
  // Ava Brain's own reported version, last time it was known (null: never paired, or offline at the last check)
  brainVersion: string | null;
  // Which `info.version` a notification has already been sent for, so a repeat check never sends it twice
  notifiedVersion: string | null;
  // Which `info.version` the user dismissed the panel banner for
  bannerDismissedVersion: string | null;
  // The extension was just updated (chrome.runtime.onInstalled, reason "update"): from which version to which, so
  // the panel can say what changed. Cleared when the user closes the "What's new" card
  justUpdated: { from: string; to: string; at: number } | null;
}

export const DEFAULT_UPDATE_STATUS: UpdateStatus = {
  checkedAt: null,
  error: null,
  info: null,
  extensionUpdateAvailable: false,
  brainUpdateAvailable: false,
  brainVersion: null,
  notifiedVersion: null,
  bannerDismissedVersion: null,
  justUpdated: null,
};

const settingsStorage = createStorage<UpdateSettings>('update-settings', DEFAULT_UPDATE_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

const statusStorage = createStorage<UpdateStatus>('update-status', DEFAULT_UPDATE_STATUS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const updateSettingsStore = {
  ...settingsStorage,
  async getSettings(): Promise<UpdateSettings> {
    return { ...DEFAULT_UPDATE_SETTINGS, ...(await settingsStorage.get()) };
  },
  async update(changes: Partial<UpdateSettings>): Promise<UpdateSettings> {
    const next = { ...(await updateSettingsStore.getSettings()), ...changes };
    await settingsStorage.set(next);
    return next;
  },
};

export const updateStatusStore = {
  ...statusStorage,
  async getStatus(): Promise<UpdateStatus> {
    return { ...DEFAULT_UPDATE_STATUS, ...(await statusStorage.get()) };
  },
  async update(changes: Partial<UpdateStatus>): Promise<UpdateStatus> {
    const next = { ...(await updateStatusStore.getStatus()), ...changes };
    await statusStorage.set(next);
    return next;
  },
};
