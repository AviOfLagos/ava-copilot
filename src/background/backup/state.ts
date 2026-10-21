import { createStorage } from '@extension/storage/lib/base/base';
import { StorageEnum } from '@extension/storage/lib/base/enums';

/**
 * Backups on the Mac: the user's one choice (keep API keys and sign-ins too), and how the last backup went,
 * for Settings › Memory › Backups. The choice is a setting and is backed up; the status is not.
 */

export interface BackupSettings {
  // Keep API keys and sign-ins in the Mac's Keychain too, so a reinstall needs none typed again
  includeSecrets: boolean;
}

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = { includeSecrets: true };

export interface BackupStatus {
  lastBackupAt: number | null;
  lastSnapshotId: string | null;
  lastBytes: number | null;
  // How many API keys and sign-ins went with it; null when they were left out
  lastSecrets: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  running: boolean;
}

export const DEFAULT_BACKUP_STATUS: BackupStatus = {
  lastBackupAt: null,
  lastSnapshotId: null,
  lastBytes: null,
  lastSecrets: null,
  lastError: null,
  lastErrorAt: null,
  running: false,
};

export const BACKUP_SETTINGS_KEY = 'backup-settings';
export const BACKUP_STATUS_KEY = 'backup-status';
// A file from disk waits here (OPFS) for the background to restore it: too large for a message
export const STAGED_RESTORE_FILE = 'backup-restore.bin';

const settingsStorage = createStorage<BackupSettings>(BACKUP_SETTINGS_KEY, DEFAULT_BACKUP_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

const statusStorage = createStorage<BackupStatus>(BACKUP_STATUS_KEY, DEFAULT_BACKUP_STATUS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const backupSettingsStore = {
  ...settingsStorage,
  async getSettings(): Promise<BackupSettings> {
    return { ...DEFAULT_BACKUP_SETTINGS, ...(await settingsStorage.get()) };
  },
  async update(changes: Partial<BackupSettings>): Promise<BackupSettings> {
    const next = { ...(await backupSettingsStore.getSettings()), ...changes };
    await settingsStorage.set(next);
    return next;
  },
};

export const backupStatusStore = {
  ...statusStorage,
  async getStatus(): Promise<BackupStatus> {
    return { ...DEFAULT_BACKUP_STATUS, ...(await statusStorage.get()) };
  },
  async update(changes: Partial<BackupStatus>): Promise<BackupStatus> {
    const next = { ...(await backupStatusStore.getStatus()), ...changes };
    await statusStorage.set(next);
    return next;
  },
};
