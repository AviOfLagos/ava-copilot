import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';
import { BULK_HARD_DAILY_CAP, BULK_MIN_DELAY_SEC, DEFAULT_BULK_SETTINGS } from './types';
import type { BulkDailyCount, BulkRun, BulkSettings } from './types';

/** Settings for bulk messages, clamped to the safety limits; whatever is stored, a read never exceeds them. */
export function clampBulkSettings(input: Partial<BulkSettings>): BulkSettings {
  const merged = { ...DEFAULT_BULK_SETTINGS, ...input };
  const whole = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  const delayMinSec = Math.max(BULK_MIN_DELAY_SEC, whole(merged.delayMinSec, DEFAULT_BULK_SETTINGS.delayMinSec));
  const delayMaxSec = Math.max(delayMinSec, whole(merged.delayMaxSec, DEFAULT_BULK_SETTINGS.delayMaxSec));
  const cooldownEvery = Math.max(1, whole(merged.cooldownEvery, DEFAULT_BULK_SETTINGS.cooldownEvery));
  const cooldownMinSec = Math.max(1, whole(merged.cooldownMinSec, DEFAULT_BULK_SETTINGS.cooldownMinSec));
  const cooldownMaxSec = Math.max(cooldownMinSec, whole(merged.cooldownMaxSec, DEFAULT_BULK_SETTINGS.cooldownMaxSec));
  const dailyCap = Math.min(BULK_HARD_DAILY_CAP, Math.max(1, whole(merged.dailyCap, DEFAULT_BULK_SETTINGS.dailyCap)));
  return { delayMinSec, delayMaxSec, cooldownEvery, cooldownMinSec, cooldownMaxSec, dailyCap };
}

const settingsStorage: BaseStorage<BulkSettings> = createStorage<BulkSettings>(
  'whatsapp-bulk-settings',
  DEFAULT_BULK_SETTINGS,
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

export const whatsappBulkSettingsStore = {
  ...settingsStorage,
  async getSettings(): Promise<BulkSettings> {
    return clampBulkSettings((await settingsStorage.get()) ?? {});
  },
  async updateSettings(changes: Partial<BulkSettings>): Promise<BulkSettings> {
    const next = clampBulkSettings({ ...(await whatsappBulkSettingsStore.getSettings()), ...changes });
    await settingsStorage.set(next);
    return next;
  },
};

// The runs the panel shows, newest first. Written only by the background.
export const whatsappBulkRunsStore: BaseStorage<BulkRun[]> = createStorage<BulkRun[]>('whatsapp-bulk-runs', [], {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

// How many bulk messages went out today, for the daily cap
export const whatsappBulkDailyStore: BaseStorage<BulkDailyCount> = createStorage<BulkDailyCount>(
  'whatsapp-bulk-daily',
  { day: '', sent: 0 },
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

/** Where a run's attachment is kept (base64), apart from the run so the list stays small. */
export const bulkAttachmentKey = (runId: string) => `whatsapp-bulk-file:${runId}`;
