import { AppError, toAppError } from '@extension/shared';
import type { ObsidianSyncState, ObsidianVaultSetting, Workspace } from '@extension/storage';
import { EXPORT_ROOT, MARKER, readFrontmatter } from '@src/side-panel/vault/markdown';
import type { CompanionClient } from '../companion/client';

/**
 * One sync of the Obsidian vault through Nex Brain, the same two halves as the browser folder's
 * (src/side-panel/vault/vault.ts): the copilot's memory out to the vault's `Nex Copilot` folder, and the user's
 * own changed notes into the knowledge base. The same rules hold: only changed files are written, a file the user
 * wrote is never replaced or removed (Nex Brain checks the marker in its front matter too), and nothing outside
 * the vault is touched (Nex Brain confines every path). Notes become knowledge-base items, which reach a model
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
    'obsidianNotes' | 'obsidianRead' | 'obsidianWrite' | 'obsidianRemove' | 'obsidianChoose'
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
        onlyIfMarker: MARKER,
      });
      count++;
    } catch (error) {
      const appError = toAppError(error);
      // A note of the user's own at this path is left alone; one Nex Brain will not take (too large, a bad name) too
      if (appError.kind === 'forbidden' || appError.kind === 'invalid') {
        delete next[path];
        continue;
      }
      throw appError;
    }
  }
  for (const path of Object.keys(written)) {
    if (next[path] || !path.startsWith(`${EXPORT_ROOT}/`)) continue;
    await deps.client.obsidianRemove({ requestId: requestId(), vaultId, path, onlyIfMarker: MARKER }).catch(error => {
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

/**
 * One full sync. When Nex Brain has no vault chosen any more (it was reinstalled or paired anew), the vault this
 * browser chose is chosen again from its path, once: the user picked it before.
 */
export async function syncBrainVault(deps: BrainVaultSyncDeps): Promise<{ written: number; read: number }> {
  const now = deps.now ?? Date.now;
  let setting = await deps.setting.get();
  if (setting.source !== 'brain' || !setting.vaultId) return { written: 0, read: 0 };
  const state = await deps.state.get();

  const run = async (vaultId: string) => {
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
      counts = await run(setting.vaultId);
    } catch (error) {
      const appError = toAppError(error);
      if (appError.kind !== 'not_found' || !setting.path) throw appError;
      const { vault } = await deps.client.obsidianChoose(
        (deps.requestId ?? (() => crypto.randomUUID()))(),
        setting.path,
      );
      if (vault.id !== setting.vaultId) {
        // Another folder answers at that path now: start over with it, as with a vault chosen anew
        await deps.state.update({ written: {}, read: {} });
        state.written = {};
        state.read = {};
      }
      setting = { ...setting, vaultId: vault.id, name: vault.name };
      await deps.setting.update({ vaultId: vault.id, name: vault.name });
      counts = await run(vault.id);
    }
    await deps.state.update({ lastSyncAt: now(), lastError: null, lastCounts: counts });
    return counts;
  } catch (error) {
    const appError = AppError.isInstance(error) ? error : toAppError(error);
    await deps.state.update({ lastSyncAt: now(), lastError: appError.message });
    throw appError;
  }
}
