// Obsidian through Ava Brain: the vault on the Mac is read and written by the companion, so it works in Brave
// (no folder picker), needs no access click after a restart, and survives a reinstall (the choice is a setting).
// The browser folder (src/side-panel/vault) stays as the fallback when Ava Brain is not paired.
import { z } from 'zod';
import { toAppError } from '@extension/shared';
import {
  db,
  DEFAULT_OBSIDIAN_SYNC,
  graphStore,
  kbStore,
  obsidianSyncStore,
  obsidianVaultStore,
  VAULT_STATE_KEY,
  workspaceStore,
} from '@extension/storage';
import type { VaultState } from '@extension/storage';
import { vaultNotes } from '@src/side-panel/vault/markdown';
import { companionClient } from '../companion/client';
import { brainSettingsStore } from '../companion/state';
import { jobs, registerJobHandler } from '../jobs/runner';
import { createLogger } from '../log';
import { answerOneOff, registerCommand, registerRecovery } from '../registry';
import { services } from '../registry/services';
import { syncBrainVault, vaultToAdopt } from './sync';

const logger = createLogger('Obsidian');

export const OBSIDIAN_SYNC_JOB = 'obsidian_sync';
const SYNC_KEY = 'obsidian:sync';
// As often as the panel syncs the browser folder, and with the panel closed too
const SYNC_CRON = '*/10 * * * *';

function command<S extends z.ZodType>(
  type: string,
  schema: S,
  run: (input: z.infer<S>) => Promise<Record<string, unknown> | void>,
): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      const result = (await run(input)) ?? {};
      context.reply({ type: 'obsidian_ok', requestId: context.requestId, ...result });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message, kind: appError.kind });
    }
  });
}

/** The copilot's memory as vault files, read from the database as the panel's sync reads it. */
async function memoryFiles(): Promise<Map<string, string>> {
  const workspaces = await workspaceStore.list();
  const items = await kbStore.items();
  const chunks = await kbStore.chunks();
  const byItem = new Map<string, typeof chunks>();
  for (const chunk of chunks) byItem.set(chunk.itemId, [...(byItem.get(chunk.itemId) ?? []), chunk]);
  const threadIds = items.filter(item => item.sourceType === 'thread').map(item => item.sourceId);
  const messages = await db.messages.where('threadId').anyOf(threadIds).sortBy('seq');
  const meetings = new Map((await db.meetings.toArray()).map(meeting => [meeting.id, meeting]));
  return vaultNotes({
    workspaces,
    items,
    chunks: id => byItem.get(id) ?? [],
    messages: id => messages.filter(message => message.threadId === id),
    meeting: id => meetings.get(id),
    nodes: await graphStore.nodes(),
    edges: await graphStore.edges(),
  });
}

let running: Promise<{ written: number; read: number }> | null = null;

/** One sync at a time; a second caller waits for the one running. */
export function syncNow(): Promise<{ written: number; read: number }> {
  running ??= (async () => {
    try {
      return await syncBrainVault({
        client: companionClient,
        setting: { get: () => obsidianVaultStore.getSetting(), update: changes => obsidianVaultStore.update(changes) },
        state: { get: () => obsidianSyncStore.getState(), update: changes => obsidianSyncStore.update(changes) },
        files: memoryFiles,
        workspaces: () => workspaceStore.list(),
        saveNotes: notes => services().kb.saveVaultNotes(notes),
        removeNotes: paths => services().kb.removeVaultNotes(paths),
      });
    } finally {
      running = null;
    }
  })();
  return running;
}

/** The summary the guided setup reads ("Set it up with Ava"): connected through Ava Brain needs no access click. */
async function recordState(name: string | null): Promise<void> {
  const state: VaultState = { support: 'ok', name, access: name ? 'granted' : null };
  await chrome.storage.local.set({ [VAULT_STATE_KEY]: state }).catch(() => {});
}

const snapshot = async () => ({
  paired: (await brainSettingsStore.getSettings()).paired,
  setting: await obsidianVaultStore.getSetting(),
  sync: await obsidianSyncStore.getState(),
});

command('obsidian_state', z.object({}), snapshot);

command('obsidian_vaults', z.object({}), async () => {
  const { vaults, chosen } = await companionClient.obsidianVaults();
  return { vaults, chosen };
});

/** Chooses the vault in Ava Brain and syncs it from now on. */
async function useVault(path: string): Promise<void> {
  const { vault } = await companionClient.obsidianChoose(crypto.randomUUID(), path);
  const before = await obsidianVaultStore.getSetting();
  if (before.vaultId !== vault.id) await obsidianSyncStore.set({ ...DEFAULT_OBSIDIAN_SYNC });
  else await obsidianSyncStore.update({ needsChoice: false, lastError: null });
  await obsidianVaultStore.update({
    source: 'brain',
    vaultId: vault.id,
    path: vault.path,
    name: vault.name,
    chosenAt: Date.now(),
  });
  await recordState(vault.name);
  await jobs.schedule({ kind: OBSIDIAN_SYNC_JOB, key: SYNC_KEY, cron: SYNC_CRON, catchUpMs: 60_000 });
  // The first sync can take a while on a large vault: it runs on, and the card shows how it went
  void syncNow().catch(error => logger.warning('First vault sync failed', toAppError(error).kind));
}

command('obsidian_use', z.object({ path: z.string().trim().min(1).max(1000) }), async ({ path }) => {
  await useVault(path);
  return snapshot();
});

// `local`: only this browser lets go (Ava Brain's choice may be another browser's, and stays)
command('obsidian_disconnect', z.object({ local: z.boolean().optional() }), async ({ local }) => {
  if (!local) await companionClient.obsidianForget().catch(() => {});
  await obsidianVaultStore.update({ source: null, vaultId: null, path: null, name: null, chosenAt: null });
  await obsidianSyncStore.set({ ...DEFAULT_OBSIDIAN_SYNC });
  await jobs.cancel(SYNC_KEY);
  await recordState(null);
  return snapshot();
});

command('obsidian_read_notes', z.object({ on: z.boolean() }), async ({ on }) => {
  await obsidianVaultStore.update({ readNotes: on });
  return snapshot();
});

command('obsidian_sync', z.object({}), async () => {
  const counts = await syncNow();
  return { ...counts, ...(await snapshot()) };
});

registerJobHandler(OBSIDIAN_SYNC_JOB, async () => {
  const setting = await obsidianVaultStore.getSetting();
  if (setting.source !== 'brain' || !(await brainSettingsStore.getSettings()).paired) return;
  await syncNow();
});

/**
 * Ava Brain is paired but its vault is not chosen, while this browser had its own folder: choose the vault of the
 * same name in Ava Brain, so it stays connected through restarts and updates with no access click. The browser
 * folder keeps its own setting until the user lets it go.
 */
async function adoptBrowserVault(): Promise<void> {
  const setting = await obsidianVaultStore.getSetting();
  if (setting.source === 'brain' || !(await brainSettingsStore.getSettings()).paired) return;
  const stored = (await chrome.storage.local.get(VAULT_STATE_KEY))[VAULT_STATE_KEY] as VaultState | undefined;
  if (!stored?.name) return;
  const { vaults, chosen } = await companionClient.obsidianVaults();
  const vault = vaultToAdopt(vaults, chosen, stored.name);
  if (!vault) return;
  await useVault(vault.path);
  logger.info('Chose the same vault in Ava Brain');
}

const adoptQuietly = () =>
  void adoptBrowserVault().catch(error => logger.warning('Choosing the vault in Ava Brain', toAppError(error).kind));

// Pairing Ava Brain (now or later) moves the browser folder's vault over
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== 'local' || !changes['brain-settings']) return;
  const before = changes['brain-settings'].oldValue as { paired?: boolean } | undefined;
  const after = changes['brain-settings'].newValue as { paired?: boolean } | undefined;
  if (after?.paired && !before?.paired) adoptQuietly();
});

// After a restart or a restore: keep syncing the vault Ava Brain uses (scheduling the same key replaces the job)
registerRecovery('obsidian', async () => {
  const setting = await obsidianVaultStore.getSetting();
  if (setting.source !== 'brain') return adoptQuietly();
  await recordState(setting.name);
  await jobs.schedule({ kind: OBSIDIAN_SYNC_JOB, key: SYNC_KEY, cron: SYNC_CRON, catchUpMs: 60_000 });
});

// The panel's settings send these as one-off messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if (typeof message?.type !== 'string' || !message.type.startsWith('obsidian_')) return;
  return answerOneOff(message, sendResponse);
});
