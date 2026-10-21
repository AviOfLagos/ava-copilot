import { describe, expect, it } from 'vitest';
import { AppError } from '@extension/shared';
import { DEFAULT_OBSIDIAN_SYNC, DEFAULT_OBSIDIAN_VAULT } from '@extension/storage';
import type { ObsidianSyncState, ObsidianVaultSetting, Workspace } from '@extension/storage';
import { MAX_NOTE_BYTES, syncBrainVault } from '../sync';
import type { BrainVaultSyncDeps } from '../sync';

const OURS = '---\nsource: avi-copilot\n---\n';

/** A vault in memory behind a fake Nex Brain client: nothing touches a disk or the network. */
function harness(options: {
  files?: Map<string, string>;
  notes?: Record<string, { text: string; mtime: number; size?: number }>;
  setting?: Partial<ObsidianVaultSetting>;
  state?: Partial<ObsidianSyncState>;
  chosenId?: string;
  workspaces?: Workspace[];
}) {
  const vault = new Map(Object.entries(options.notes ?? {}));
  let chosenId = options.chosenId ?? 'aaaaaaaaaaaaaaaa';
  let setting: ObsidianVaultSetting = {
    ...DEFAULT_OBSIDIAN_VAULT,
    source: 'brain',
    vaultId: 'aaaaaaaaaaaaaaaa',
    path: '/Users/avi/Vault',
    name: 'Vault',
    ...options.setting,
  };
  let state: ObsidianSyncState = { ...DEFAULT_OBSIDIAN_SYNC, ...options.state };
  const saved: { path: string; workspaceId: string | null }[] = [];
  const removed: string[] = [];
  const writes: string[] = [];
  const removes: string[] = [];
  const check = (vaultId: string) => {
    if (vaultId !== chosenId) throw new AppError('not_found', 'No Obsidian vault is chosen in Nex Brain.');
  };
  const client: BrainVaultSyncDeps['client'] = {
    async obsidianNotes(vaultId, { cursor } = {}) {
      check(vaultId);
      const all = [...vault.keys()].sort().filter(path => cursor == null || path > cursor);
      const page = all.slice(0, 2);
      return {
        ok: true as const,
        notes: page.map(path => ({
          path,
          mtime: vault.get(path)!.mtime,
          size: vault.get(path)!.size ?? vault.get(path)!.text.length,
        })),
        next: all.length > 2 ? page[1] : null,
        capped: false,
      };
    },
    async obsidianRead(vaultId, paths) {
      check(vaultId);
      return {
        ok: true as const,
        notes: paths
          .filter(path => vault.has(path))
          .map(path => ({ path, text: vault.get(path)!.text, mtime: vault.get(path)!.mtime, size: 1 })),
        skipped: [],
      };
    },
    async obsidianWrite(request) {
      check(request.vaultId);
      const existing = vault.get(request.path);
      if (existing && request.onlyIfMarker && !existing.text.startsWith(OURS))
        throw new AppError('forbidden', 'Not ours.');
      writes.push(request.path);
      vault.set(request.path, { text: request.text, mtime: 99 });
      return { ok: true as const, path: request.path, mtime: 99, created: !existing };
    },
    async obsidianRemove(request) {
      check(request.vaultId);
      const existing = vault.get(request.path);
      if (existing && !existing.text.startsWith(OURS)) throw new AppError('forbidden', 'Not ours.');
      removes.push(request.path);
      return { ok: true as const, removed: vault.delete(request.path) };
    },
    async obsidianChoose(_requestId, path) {
      chosenId = 'bbbbbbbbbbbbbbbb';
      return {
        ok: true as const,
        vault: { id: chosenId, name: 'Vault', path, found: 'chosen' as const, usable: true },
      };
    },
  };
  const deps: BrainVaultSyncDeps = {
    client,
    setting: {
      get: async () => setting,
      update: async changes => {
        setting = { ...setting, ...changes };
      },
    },
    state: {
      get: async () => state,
      update: async changes => {
        state = { ...state, ...changes };
      },
    },
    files: async () => options.files ?? new Map(),
    workspaces: async () => options.workspaces ?? [],
    saveNotes: async notes => {
      saved.push(...notes.map(note => ({ path: note.path, workspaceId: note.workspaceId })));
    },
    removeNotes: async paths => {
      removed.push(...paths);
    },
    now: () => 1000,
    requestId: () => 'request-0001',
  };
  return { deps, vault, saved, removed, writes, removes, getState: () => state, getSetting: () => setting };
}

describe('syncBrainVault', () => {
  it('does nothing without a vault chosen through Nex Brain', async () => {
    const { deps, writes } = harness({ setting: { source: null } });
    expect(await syncBrainVault(deps)).toEqual({ written: 0, read: 0 });
    expect(writes).toEqual([]);
  });

  it('writes only changed files, never over the user’s own, and only in its folder', async () => {
    const files = new Map([
      ['Nex Copilot/Chats/One.md', `${OURS}one`],
      ['Nex Copilot/Mine.md', `${OURS}two`],
      ['Elsewhere.md', `${OURS}never`],
    ]);
    const { deps, writes, vault, getState } = harness({
      files,
      notes: { 'Nex Copilot/Mine.md': { text: 'the user wrote this', mtime: 5 } },
    });
    expect((await syncBrainVault(deps)).written).toBe(1);
    expect(writes).toEqual(['Nex Copilot/Chats/One.md']);
    expect(vault.get('Nex Copilot/Mine.md')?.text).toBe('the user wrote this');
    expect(Object.keys(getState().written)).toEqual(['Nex Copilot/Chats/One.md']);
    // Nothing changed: nothing written the second time
    writes.length = 0;
    expect((await syncBrainVault(deps)).written).toBe(0);
    expect(writes).toEqual([]);
  });

  it('removes its own stale files only', async () => {
    const { deps, removes } = harness({
      state: { written: { 'Nex Copilot/Old.md': 'x', 'Nex Copilot/Theirs.md': 'y' } },
      notes: {
        'Nex Copilot/Old.md': { text: `${OURS}old`, mtime: 1 },
        'Nex Copilot/Theirs.md': { text: 'edited by the user', mtime: 1 },
      },
    });
    await syncBrainVault(deps);
    expect(removes).toEqual(['Nex Copilot/Old.md']);
  });

  it('reads the user’s changed notes into memory, by workspace, across pages, and lets go of deleted ones', async () => {
    const { deps, saved, removed, getState } = harness({
      workspaces: [{ id: 'w-zedu', name: 'Zedu' } as Workspace],
      notes: {
        'Zedu/Plan.md': { text: 'tower plan', mtime: 10 },
        'Daily.md': { text: '---\nworkspace: Zedu\n---\ntoday', mtime: 11 },
        'Empty.md': { text: '   ', mtime: 12 },
        'Nex Copilot/Chats/One.md': { text: `${OURS}ours`, mtime: 13 },
        'Huge.md': { text: 'x', mtime: 14, size: MAX_NOTE_BYTES + 1 },
      },
      state: { read: { 'Gone.md': 3, 'Daily.md': 11 } },
    });
    const counts = await syncBrainVault(deps);
    expect(counts.read).toBe(1);
    expect(saved).toEqual([{ path: 'Zedu/Plan.md', workspaceId: 'w-zedu' }]);
    expect(removed).toEqual(['Gone.md']);
    expect(Object.keys(getState().read).sort()).toEqual(['Daily.md', 'Empty.md', 'Zedu/Plan.md']);
    expect(getState().lastCounts).toEqual({ written: 0, read: 1 });
  });

  it('skips reading notes when the user turned it off', async () => {
    const { deps, saved } = harness({ setting: { readNotes: false }, notes: { 'A.md': { text: 'a', mtime: 1 } } });
    await syncBrainVault(deps);
    expect(saved).toEqual([]);
  });

  it('chooses the vault again from its path when Nex Brain no longer has it, starting over for a new one', async () => {
    const { deps, getSetting, saved } = harness({
      chosenId: 'cccccccccccccccc',
      notes: { 'A.md': { text: 'a', mtime: 1 } },
      state: { read: { 'A.md': 1 } },
    });
    await syncBrainVault(deps);
    expect(getSetting().vaultId).toBe('bbbbbbbbbbbbbbbb');
    // A different vault: its notes are read as new
    expect(saved.map(note => note.path)).toEqual(['A.md']);
  });

  it('keeps the error for the card and throws it', async () => {
    const { deps, getState } = harness({ setting: { path: null }, chosenId: 'cccccccccccccccc' });
    await expect(syncBrainVault(deps)).rejects.toThrow(/No Obsidian vault/);
    expect(getState().lastError).toMatch(/No Obsidian vault/);
  });
});
