import { createStorage } from '@extension/storage/lib/base/base';
import { StorageEnum } from '@extension/storage/lib/base/enums';
import { COMPANION_DEFAULT_PORT } from '@src/shared/lib/protocol/companion';
import type { DockerState, McpServerState } from '@src/shared/lib/protocol/companion';

/**
 * What the extension knows about Avi Brain, for the background and the panel: where it listens, whether
 * this browser is paired, and how it was last time it was asked. Nothing secret: the token lives in the
 * vault (src/storage/lib/secrets) under BRAIN_TOKEN_REF, and only the background reads it.
 */

export const BRAIN_TOKEN_REF = 'companion:token';

export interface BrainSettings {
  port: number;
  paired: boolean;
  companionId: string | null;
  pairedAt: number | null;
}

export const DEFAULT_BRAIN_SETTINGS: BrainSettings = {
  port: COMPANION_DEFAULT_PORT,
  paired: false,
  companionId: null,
  pairedAt: null,
};

export type BrainState = 'unpaired' | 'online' | 'offline' | 'error';

/** For the shell and Settings: a light and a sentence. */
export interface BrainStatus {
  state: BrainState;
  checkedAt: number | null;
  // A plain sentence when something needs the user (start Avi Brain, start Docker, pair again)
  message: string | null;
  version: string | null;
  docker: DockerState | null;
  engine: { kind: string; state: string; message: string | null } | null;
  mcp: McpServerState[];
}

export const DEFAULT_BRAIN_STATUS: BrainStatus = {
  state: 'unpaired',
  checkedAt: null,
  message: null,
  version: null,
  docker: null,
  engine: null,
  mcp: [],
};

const settingsStorage = createStorage<BrainSettings>('brain-settings', DEFAULT_BRAIN_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

const statusStorage = createStorage<BrainStatus>('brain-status', DEFAULT_BRAIN_STATUS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const brainSettingsStore = {
  ...settingsStorage,
  async getSettings(): Promise<BrainSettings> {
    return { ...DEFAULT_BRAIN_SETTINGS, ...(await settingsStorage.get()) };
  },
  async update(changes: Partial<BrainSettings>): Promise<BrainSettings> {
    const next = { ...(await brainSettingsStore.getSettings()), ...changes };
    await settingsStorage.set(next);
    return next;
  },
};

export const brainStatusStore = {
  ...statusStorage,
  async getStatus(): Promise<BrainStatus> {
    return { ...DEFAULT_BRAIN_STATUS, ...(await statusStorage.get()) };
  },
  async update(changes: Partial<BrainStatus>): Promise<BrainStatus> {
    const next = { ...(await brainStatusStore.getStatus()), ...changes };
    await statusStorage.set(next);
    return next;
  },
};

export function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535;
}
