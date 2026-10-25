import { AppError, toAppError } from '@extension/shared';
import type { ObsidianSyncState, ObsidianVaultSetting, Workspace } from '@extension/storage';
import { EXPORT_ROOT, readFrontmatter } from '@src/side-panel/vault/markdown';
import type { ObsidianVault } from '@src/shared/lib/protocol/companion';
import type { CompanionClient } from '../companion/client';

/**
 * One sync of the Obsidian vault through Ava Brain, the same two halves as the browser folder's
 * (src/side-panel/vault/vault.ts): the copilot's memory out to the vault's `Ava Copilot` folder, and the user's
 * own changed notes into the knowledge base. The same rules hold: only changed files are written, a file the user
 * wrote is never replaced or removed (Ava Brain checks the marker in its front matter too), and nothing outside
 * the vault is touched (Ava Brain confines every path). Notes become knowledge-base items, which reach a model
 * only wrapped as untrusted content.
 */

// As the browser folder reads: at most this many notes, each at most this long
export const MAX_NOTES = 3000;
export const MAX_NOTE_BYTES = 300_000;
const READ_BATCH = 50;
const SAVE_BATCH = 50;

export interface VaultNoteIn {
  path: string;
  title: string;
  text: string;
  workspaceId: string | null;
  modified: number;
}

export interface BrainVaultSyncDeps {
  client: Pick<
    CompanionClient,
    'obsidianNotes' | 'obsidianRead' | 'obsidianWrite' | 'obsidianRemove' | 'obsidianChoose' | 'obsidianVaults'
  >;
  setting: { get(): Promise<ObsidianVaultSetting>; update(changes: Partial<ObsidianVaultSetting>): Promise<unknown> };
  state: { get(): Promise<ObsidianSyncState>; update(changes: Partial<ObsidianSyncState>): Promise<unknown> };
  // The copilot's memory as vault files (markdown.ts vaultNotes), path → text
  files(): Promise<Map<string, string>>;
  workspaces(): Promise<Workspace[]>;
  saveNotes(notes: VaultNoteIn[]): Promise<unknown>;
  removeNotes(paths: string[]): Promise<unknown>;
  now?: () => number;
  requestId?: () => string;
}

async function sha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Writes what changed in the copilot's folder and removes its own stale files. Returns how many were written. */
async function writeOut(deps: BrainVaultSyncDeps, vaultId: string, written: Record<string, string>) {
  const requestId = deps.requestId ?? (() => crypto.randomUUID());
  const files = await deps.files();
  const next: Record<string, string> = {};
  let count = 0;
  for (const [path, text] of files) {
    // vaultNotes only makes files under its own folder; anything else is never written
    if (!path.startsWith(`${EXPORT_ROOT}/`)) continue;
    const hash = await sha(text);
    next[path] = hash;
    if (written[path] === hash) continue;
    try {
      await deps.client.obsidianWrite({
        requestId: requestId(),
        vaultId,
        path,
        text,
        mode: 'overwrite',
      });
      count++;
    } catch (error) {
      const appError = toAppError(error);
      // A note of the user's own at this path is left alone; one Ava Brain will not take (too large, a bad name) too
      if (appError.kind === 'forbidden' || appError.kind === 'invalid') {
        delete next[path];
        continue;
      }
      throw appError;
    }
  }
  for (const path of Object.keys(written)) {
    if (next[path] || !path.startsWith(`${EXPORT_ROOT}/`)) continue;
    await deps.client.obsidianRemove({ requestId: requestId(), vaultId, path }).catch(error => {
      const kind = toAppError(error).kind;
      if (kind !== 'forbidden' && kind !== 'invalid' && kind !== 'not_found') throw error;
    });
  }
  return { count, next };
}

/** The user's notes that changed since the last sync, and the ones that are gone. */
async function readIn(deps: BrainVaultSyncDeps, vaultId: string, seen: Record<string, number>) {
  const workspaces = await deps.workspaces();
  const byName = new Map(workspaces.map(workspace => [workspace.name.trim().toLowerCase(), workspace.id]));
  const now: Record<string, number> = {};
  const changedPaths: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await deps.client.obsidianNotes(vaultId, { cursor, limit: 1000 });
    for (const note of page.notes) {
      if (Object.keys(now).length >= MAX_NOTES) break;
      if (note.path === EXPORT_ROOT || note.path.startsWith(`${EXPORT_ROOT}/`)) continue;
      if (note.size > MAX_NOTE_BYTES) continue;
      now[note.path] = note.mtime;
      if (seen[note.path] !== note.mtime) changedPaths.push(note.path);
    }
    cursor = Object.keys(now).length >= MAX_NOTES ? null : page.next;
  } while (cursor);

  const changed: VaultNoteIn[] = [];
  for (let at = 0; at < changedPaths.length; at += READ_BATCH) {
    const { notes, skipped } = await deps.client.obsidianRead(vaultId, changedPaths.slice(at, at + READ_BATCH));
    // A note the batch had no room for is read next time
    for (const skip of skipped) if (skip.reason === 'batch_full') delete now[skip.path];
    for (const note of notes) {
      const { workspace, ours, body } = readFrontmatter(note.text);
      if (ours || !body.trim()) continue;
      const name = note.path.split('/').at(-1) ?? note.path;
      const top = note.path.split('/')[0].toLowerCase();
      changed.push({
        path: note.path,
        title: name.replace(/\.md$/i, ''),
        text: body,
        workspaceId: (workspace && byName.get(workspace.toLowerCase())) || byName.get(top) || null,
        modified: note.mtime,
      });
    }
  }
  return { now, changed, gone: Object.keys(seen).filter(path => !(path in now)) };
}

export const CHOOSE_AGAIN_MESSAGE =
  'Choose your vault again: Ava Brain has another vault chosen now, or cannot find this one.';

/**
 * What to do when Ava Brain says the vault is not the chosen one. Its vault is chosen again from the saved path only
 * when Ava Brain has none chosen (it was reinstalled or paired anew) and the path still resolves to this very vault.
 * A different vault chosen there (by the user, or by another paired browser) is never undone: this browser stops
 * syncing and asks the user to choose again. Returns whether syncing may go on.
 */
async function recoverChoice(deps: BrainVaultSyncDeps, setting: ObsidianVaultSetting): Promise<boolean> {
  if (!setting.path || !setting.vaultId) return false;
  const { chosen } = await deps.client.obsidianVaults();
  if (chosen) return false;
  try {
    const { vault } = await deps.client.obsidianChoose(
      (deps.requestId ?? (() => crypto.randomUUID()))(),
      setting.path,
      setting.vaultId,
    );
    return vault.id === setting.vaultId;
  } catch (error) {
    const kind = toAppError(error).kind;
    if (kind === 'not_found' || kind === 'invalid' || kind === 'forbidden') return false;
    throw error;
  }
}

/**
 * One full sync. Stops (and the card asks to choose again) when Ava Brain's vault is no longer this browser's:
 * see recoverChoice.
 */
export async function syncBrainVault(deps: BrainVaultSyncDeps): Promise<{ written: number; read: number }> {
  const now = deps.now ?? Date.now;
  const setting = await deps.setting.get();
  if (setting.source !== 'brain' || !setting.vaultId) return { written: 0, read: 0 };
  const state = await deps.state.get();
  if (state.needsChoice) return { written: 0, read: 0 };
  const vaultId = setting.vaultId;

  const run = async () => {
    const out = await writeOut(deps, vaultId, state.written);
    await deps.state.update({ written: out.next });
    let read = 0;
    if (setting.readNotes) {
      const { now: listed, changed, gone } = await readIn(deps, vaultId, state.read);
      for (let at = 0; at < changed.length; at += SAVE_BATCH) await deps.saveNotes(changed.slice(at, at + SAVE_BATCH));
      if (gone.length) await deps.removeNotes(gone);
      await deps.state.update({ read: listed });
      read = changed.length;
    }
    return { written: out.count, read };
  };

  try {
    let counts: { written: number; read: number };
    try {
      counts = await run();
    } catch (error) {
      const appError = toAppError(error);
      if (appError.kind !== 'not_found') throw appError;
      if (!(await recoverChoice(deps, setting))) {
        await deps.state.update({ needsChoice: true });
        throw new AppError('not_found', CHOOSE_AGAIN_MESSAGE);
      }
      counts = await run();
    }
    await deps.state.update({ lastSyncAt: now(), lastError: null, lastCounts: counts });
    return counts;
  } catch (error) {
    const appError = AppError.isInstance(error) ? error : toAppError(error);
    await deps.state.update({ lastSyncAt: now(), lastError: appError.message });
    throw appError;
  }
}

/**
 * The vault to choose in Ava Brain for the folder this browser already had, by name: only one usable vault of
 * that name, and only when Ava Brain has none chosen or has that very one (another browser's choice stays).
 */
export function vaultToAdopt(
  vaults: ObsidianVault[],
  chosen: ObsidianVault | null,
  browserName: string | null,
): ObsidianVault | null {
  const name = browserName?.trim().toLowerCase();
  if (!name) return null;
  if (chosen) return chosen.usable && chosen.name.trim().toLowerCase() === name ? chosen : null;
  const same = vaults.filter(vault => vault.usable && vault.name.trim().toLowerCase() === name);
  return same.length === 1 ? same[0] : null;
}
