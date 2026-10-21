import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';

/**
 * The Obsidian vault Nex Brain reads and writes on the Mac (src/background/obsidian). Unlike the browser's
 * folder handle (IndexedDB `avi-vault`), this is a plain setting, so it is in every backup and a reinstall finds
 * the same vault again. A backup *file* never sets it (backup/trust.ts keeps the one on this browser).
 */

export const OBSIDIAN_VAULT_KEY = 'obsidian-vault';

export interface ObsidianVaultSetting {
  // 'brain': Nex Brain on the Mac; null: none (the browser folder, if any, is the panel's own)
  source: 'brain' | null;
  vaultId: string | null;
  // The vault's folder on the Mac, to choose it again after a reinstall or on a new pairing
  path: string | null;
  name: string | null;
  readNotes: boolean;
  chosenAt: number | null;
}

export const DEFAULT_OBSIDIAN_VAULT: ObsidianVaultSetting = {
  source: null,
  vaultId: null,
  path: null,
  name: null,
  readNotes: true,
  chosenAt: null,
};

// What the last sync wrote (path → hash of the text) and read (path → mtime), and how it went
export const OBSIDIAN_SYNC_KEY = 'obsidian-vault-sync';

export interface ObsidianSyncState {
  written: Record<string, string>;
  read: Record<string, number>;
  lastSyncAt: number | null;
  lastError: string | null;
  lastCounts: { written: number; read: number } | null;
}

export const DEFAULT_OBSIDIAN_SYNC: ObsidianSyncState = {
  written: {},
  read: {},
  lastSyncAt: null,
  lastError: null,
  lastCounts: null,
};

const settingStorage = createStorage<ObsidianVaultSetting>(OBSIDIAN_VAULT_KEY, DEFAULT_OBSIDIAN_VAULT, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

const syncStorage = createStorage<ObsidianSyncState>(OBSIDIAN_SYNC_KEY, DEFAULT_OBSIDIAN_SYNC, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const obsidianVaultStore = {
  ...settingStorage,
  async getSetting(): Promise<ObsidianVaultSetting> {
    return { ...DEFAULT_OBSIDIAN_VAULT, ...(await settingStorage.get()) };
  },
  async update(changes: Partial<ObsidianVaultSetting>): Promise<ObsidianVaultSetting> {
    const next = { ...(await obsidianVaultStore.getSetting()), ...changes };
    await settingStorage.set(next);
    return next;
  },
};

export const obsidianSyncStore = {
  ...syncStorage,
  async getState(): Promise<ObsidianSyncState> {
    return { ...DEFAULT_OBSIDIAN_SYNC, ...(await syncStorage.get()) };
  },
  async update(changes: Partial<ObsidianSyncState>): Promise<ObsidianSyncState> {
    const next = { ...(await obsidianSyncStore.getState()), ...changes };
    await syncStorage.set(next);
    return next;
  },
};
