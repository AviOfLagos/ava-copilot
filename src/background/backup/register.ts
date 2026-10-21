// Backups to Nex Brain: panel commands, the automatic and daily jobs, and the change tracking that plans them
// (see ../registry and ../jobs/runner). Needs one import line in ../registers.ts: `import './backup/register';`
import { z } from 'zod';
import { toAppError } from '@extension/shared';
import { AviCopilotDb, db, onboardingStore, secretVault } from '@extension/storage';
import { backupIdSchema } from '@src/shared/lib/protocol/companion';
import { jobs, registerJobHandler } from '../jobs/runner';
import { createLogger } from '../log';
import { registerCommand, registerRecovery } from '../registry';
import { companionClient } from '../companion/client';
import { brainSettingsStore } from '../companion/state';
import { isRestoring } from './restore';
import { ChangeTracker } from './schedule';
import { BackupService } from './service';
import { EXCLUDED_TABLES, isExcludedStorageKey } from './snapshot';
import { backupSettingsStore, backupStatusStore, STAGED_RESTORE_FILE } from './state';

const logger = createLogger('Backup');

export const AUTO_JOB = 'backup_auto';
export const DAILY_JOB = 'backup_daily';
const AUTO_KEY = 'backup:auto';
const DAILY_KEY = 'backup:daily';
// Once a day at 13:00, when the browser is likely open; a day missed is caught up within 20 hours
const DAILY_CRON = '0 13 * * *';
const RELOAD_DELAY_MS = 1200;

const area = chrome.storage.local;

export const backupService = new BackupService({
  client: companionClient,
  source: { db, storage: area, extensionVersion: chrome.runtime.getManifest().version },
  target: { db, makeDb: name => new AviCopilotDb(name), storage: area, secrets: secretVault },
  vault: secretVault,
  paired: async () => (await brainSettingsStore.getSettings()).paired,
  settings: () => backupSettingsStore.getSettings(),
  status: { get: () => backupStatusStore.getStatus(), update: changes => backupStatusStore.update(changes) },
});

// What the tracker may know without waiting: paired, and past the first-run setup (a fresh install never
// sends an empty snapshot that would sit on top of the real ones)
const ready = { paired: false, onboarded: false };
const refreshReady = async () => {
  ready.paired = (await brainSettingsStore.getSettings()).paired;
  ready.onboarded = ((await onboardingStore.get())?.completedAt ?? 0) > 0;
};
void refreshReady().catch(() => {});

const tracker = new ChangeTracker({
  now: Date.now,
  paused: () => isRestoring() || !ready.paired || !ready.onboarded,
  schedule: async runAt => {
    await jobs.schedule({ kind: AUTO_JOB, key: AUTO_KEY, runAt, catchUpMs: 7 * 24 * 3600_000 });
  },
});
void backupStatusStore.getStatus().then(status => tracker.setLastBackup(status.lastBackupAt));

// Dexie hooks run inside the writer's transaction: only note the change there, plan the job after it
let queued = false;
const noteChange = () => {
  if (queued || isRestoring()) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    tracker.touch();
  });
};
// The job table is the tracker's own output, and excluded tables are not in a backup
for (const table of db.tables) {
  if (table.name === 'jobs' || Object.hasOwn(EXCLUDED_TABLES, table.name)) continue;
  table.hook('creating', () => noteChange());
  table.hook('updating', () => noteChange());
  table.hook('deleting', () => noteChange());
}
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const keys = Object.keys(changes);
  if (keys.some(key => key === 'brain-settings' || key === 'onboarding')) void refreshReady().catch(() => {});
  if (keys.some(key => !isExcludedStorageKey(key))) noteChange();
});

async function runBackup(): Promise<void> {
  await refreshReady();
  if (!ready.paired || !ready.onboarded || isRestoring()) return;
  const snapshot = await backupService.backupNow(false);
  tracker.ran(snapshot?.createdAt ?? Date.now());
}

registerJobHandler(AUTO_JOB, runBackup);
registerJobHandler(DAILY_JOB, runBackup);

registerRecovery('backup', async () => {
  await jobs.schedule({ kind: DAILY_JOB, key: DAILY_KEY, cron: DAILY_CRON, catchUpMs: 20 * 3600_000 });
  // A backup cut off by the worker stopping is not running any more
  if ((await backupStatusStore.getStatus()).running) await backupStatusStore.update({ running: false });
});

// When the browser starts: one backup a minute in, if paired
chrome.runtime.onStartup.addListener(() => {
  void jobs.schedule({ kind: AUTO_JOB, key: AUTO_KEY, runAt: Date.now() + 60_000 }).catch(() => {});
});

/** A panel command: its result is the reply; a failure becomes a plain sentence. */
function command<S extends z.ZodType>(
  type: string,
  schema: S,
  run: (input: z.infer<S>) => Promise<Record<string, unknown> | void>,
): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      const result = (await run(input)) ?? {};
      context.reply({ type: 'backup_ok', requestId: context.requestId, ...result });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
    }
  });
}

const overview = async () => ({
  settings: await backupSettingsStore.getSettings(),
  status: await backupStatusStore.getStatus(),
  paired: (await brainSettingsStore.getSettings()).paired,
});

/** After a restore every store and the search index must read the new data: start the extension again. */
function reloadSoon(): void {
  setTimeout(() => chrome.runtime.reload(), RELOAD_DELAY_MS);
}

command('backup_status', z.object({}), overview);

command('backup_set', z.object({ includeSecrets: z.boolean() }), async ({ includeSecrets }) => {
  await backupSettingsStore.update({ includeSecrets });
  // Off: the copy on the Mac goes now, not at the next backup
  if (!includeSecrets && (await brainSettingsStore.getSettings()).paired) {
    await companionClient.backupSecretsClear().catch(() => {});
    await backupStatusStore.update({ lastSecrets: null });
  }
  return overview();
});

command('backup_now', z.object({}), async () => {
  const snapshot = await backupService.backupNow(true);
  if (snapshot) tracker.ran(snapshot.createdAt);
  return { snapshot, ...(await overview()) };
});

command('backup_probe', z.object({}), async () => ({
  reachable: await companionClient.reachable(),
  paired: (await brainSettingsStore.getSettings()).paired,
}));

command('backup_list', z.object({}), async () => {
  const reply = await backupService.list();
  return { snapshots: reply.snapshots, secrets: reply.secrets };
});

// Restoring replaces everything here: the panel sends it only after the user's click on its confirm
command(
  'backup_restore',
  z.object({ snapshotId: backupIdSchema, confirmed: z.literal(true) }),
  async ({ snapshotId }) => {
    const summary = await backupService.restoreFromBrain(snapshotId);
    logger.info('Restored a backup from Nex Brain');
    reloadSoon();
    return { summary };
  },
);

command('backup_restore_file', z.object({ confirmed: z.literal(true) }), async () => {
  const root = await navigator.storage.getDirectory();
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const file = await (await root.getFileHandle(STAGED_RESTORE_FILE)).getFile();
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new Error('The backup file was not found. Choose it again.');
  }
  try {
    const summary = await backupService.restoreFromFile(bytes);
    logger.info('Restored a backup from a file');
    reloadSoon();
    return { summary };
  } finally {
    await root.removeEntry(STAGED_RESTORE_FILE).catch(() => {});
  }
});
