import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isInObsidianWriteRoot, OBSIDIAN_LIMITS, OBSIDIAN_MARKER, OBSIDIAN_WRITE_ROOT } from '@protocol';
import type { NoteMeta, ObsidianVault } from '@protocol';
import { AppError, fail } from '../errors';
import type { Logger } from '../log';
import { confinedNotePath, isVault, resolveVaultRoot } from './paths';

/**
 * The user's Obsidian vault on this Mac: which vaults Obsidian knows, the one the user chose (kept in
 * <dataDir>/obsidian.json), and the notes in it. Only Markdown notes are listed, read or written; hidden folders
 * (.obsidian, .trash, .git) and dotfiles are skipped, and symlinks are never walked.
 */

const SKIP_FOLDERS = new Set(['node_modules']);
// A listing is walked once and reused for the pages that follow
const WALK_CACHE_MS = 5000;
// How much of a note is read to look for the marker
const MARKER_HEAD_BYTES = 4096;

export interface ObsidianDeps {
  dataDir: string;
  log: Logger;
  // ~ (tests give a temporary folder)
  home?: string;
  // Obsidian's own list of vaults (default ~/Library/Application Support/obsidian/obsidian.json)
  obsidianConfig?: string;
  now?: () => number;
  // System folders refused as vaults (tests narrow it: their temporary folders are under /private)
  systemRoots?: string[];
}

interface Chosen {
  path: string;
  chosenAt: number;
}

export const vaultIdOf = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 16);

/** The vault folders in Obsidian's obsidian.json: `{ vaults: { <id>: { path, ts, open } } }`. */
export function obsidianVaultPaths(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as { vaults?: Record<string, { path?: unknown }> };
    if (!parsed || typeof parsed.vaults !== 'object' || parsed.vaults === null) return [];
    return Object.values(parsed.vaults)
      .map(vault => vault?.path)
      .filter((path): path is string => typeof path === 'string' && path.startsWith('/') && path.length < 1000)
      .slice(0, 100);
  } catch {
    return [];
  }
}

/**
 * Whether a note's front matter (at its very start) has the copilot's marker as a line of its own. The marker is
 * fixed (OBSIDIAN_MARKER), never the caller's.
 */
export function carriesMarker(head: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(head);
  return !!match && match[1].split(/\r?\n/).includes(OBSIDIAN_MARKER);
}

/** Ava Brain writes and removes only in the copilot's folder, whatever the request says. */
function requireWriteRoot(path: string): void {
  if (!isInObsidianWriteRoot(path)) fail('forbidden', `Ava Brain only writes in the ${OBSIDIAN_WRITE_ROOT} folder.`);
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

export class ObsidianVaults {
  private readonly home: string;
  private readonly configPath: string;
  private readonly chosenPath: string;
  private readonly now: () => number;
  private readonly systemRoots: string[] | undefined;
  private walked: { root: string; at: number; notes: NoteMeta[]; capped: boolean } | null = null;

  constructor(private readonly deps: ObsidianDeps) {
    this.home = deps.home ?? homedir();
    this.configPath =
      deps.obsidianConfig ?? join(this.home, 'Library', 'Application Support', 'obsidian', 'obsidian.json');
    this.chosenPath = join(deps.dataDir, 'obsidian.json');
    this.now = deps.now ?? Date.now;
    this.systemRoots = deps.systemRoots;
  }

  private chosen(): Chosen | null {
    try {
      const parsed = JSON.parse(readFileSync(this.chosenPath, 'utf8')) as Chosen;
      return typeof parsed?.path === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  private async describe(path: string, found: ObsidianVault['found']): Promise<ObsidianVault> {
    const real = await isVault(path, this.home, this.systemRoots);
    return { id: vaultIdOf(real ?? path), name: basename(real ?? path), path: real ?? path, found, usable: !!real };
  }

  /** The vaults Obsidian lists, and the chosen one. */
  async list(): Promise<{ vaults: ObsidianVault[]; chosen: ObsidianVault | null }> {
    let paths: string[] = [];
    try {
      paths = obsidianVaultPaths(await readFile(this.configPath, 'utf8'));
    } catch (error) {
      if (!isMissing(error))
        this.deps.log.warn('Could not read Obsidian’s vault list', { error: (error as Error).message });
    }
    const vaults: ObsidianVault[] = [];
    const seen = new Set<string>();
    for (const path of paths) {
      const vault = await this.describe(path, 'obsidian');
      if (seen.has(vault.id)) continue;
      seen.add(vault.id);
      vaults.push(vault);
    }
    const kept = this.chosen();
    let chosen: ObsidianVault | null = null;
    if (kept) {
      chosen = await this.describe(kept.path, 'chosen');
      const listed = vaults.find(vault => vault.id === chosen!.id);
      if (listed) chosen = listed;
    }
    return { vaults, chosen };
  }

  /**
   * Makes a folder the vault Ava Copilot reads and writes. It must be an Obsidian vault and, when `expectVaultId` is
   * given, still that vault: otherwise nothing changes.
   */
  async choose(path: string, expectVaultId?: string): Promise<ObsidianVault> {
    const root = await resolveVaultRoot(path, this.home, this.systemRoots);
    if (expectVaultId && vaultIdOf(root) !== expectVaultId) {
      fail('not_found', 'That folder is a different vault now. Choose your vault again.');
    }
    writeFileSync(this.chosenPath, JSON.stringify({ path: root, chosenAt: this.now() } satisfies Chosen), {
      mode: 0o600,
    });
    this.walked = null;
    this.deps.log.info('Obsidian vault chosen', { vault: vaultIdOf(root) });
    const listed = (await this.list()).vaults.find(vault => vault.id === vaultIdOf(root));
    return listed ?? { id: vaultIdOf(root), name: basename(root), path: root, found: 'chosen', usable: true };
  }

  forget(): void {
    if (existsSync(this.chosenPath)) writeFileSync(this.chosenPath, '{}', { mode: 0o600 });
    this.walked = null;
  }

  /** The chosen vault's root, if it is the one the caller names and is still a vault. */
  async root(vaultId: string): Promise<string> {
    const kept = this.chosen();
    if (!kept)
      fail('not_found', 'No Obsidian vault is chosen in Ava Brain. Choose one in Settings › Connections › Obsidian.');
    const root = await isVault(kept.path, this.home, this.systemRoots);
    if (!root) fail('not_found', 'The chosen Obsidian vault is gone or is no longer a vault. Choose it again.');
    if (vaultIdOf(root) !== vaultId)
      fail('not_found', 'A different Obsidian vault is chosen in Ava Brain now. Choose it again.');
    return root;
  }

  private async walk(root: string): Promise<{ notes: NoteMeta[]; capped: boolean }> {
    if (this.walked && this.walked.root === root && this.now() - this.walked.at < WALK_CACHE_MS) return this.walked;
    const notes: NoteMeta[] = [];
    let capped = false;
    const visit = async (folder: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(folder, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (notes.length >= OBSIDIAN_LIMITS.maxNotes) {
          capped = true;
          return;
        }
        // Hidden folders and files, and symlinks (which could lead anywhere), are never walked
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!SKIP_FOLDERS.has(entry.name)) await visit(join(folder, entry.name), path);
        } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
          const info = await stat(join(folder, entry.name)).catch(() => null);
          if (info) notes.push({ path, mtime: Math.floor(info.mtimeMs), size: info.size });
        }
      }
    };
    await visit(root, '');
    notes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    this.walked = { root, at: this.now(), notes, capped };
    return this.walked;
  }

  /** A page of notes in path order: after `cursor`, changed after `since`. */
  async notes(
    vaultId: string,
    options: { since: number; cursor: string | null; limit: number },
  ): Promise<{ notes: NoteMeta[]; next: string | null; capped: boolean }> {
    const root = await this.root(vaultId);
    const { notes, capped } = await this.walk(root);
    const after = options.cursor;
    const matching = notes.filter(note => (after === null || note.path > after) && note.mtime > options.since);
    const page = matching.slice(0, options.limit);
    return { notes: page, next: matching.length > page.length ? page.at(-1)!.path : null, capped };
  }

  /** Several notes' text. Notes too large, missing or not allowed are named, not thrown. */
  async read(vaultId: string, paths: string[]) {
    const root = await this.root(vaultId);
    const notes: { path: string; text: string; mtime: number; size: number }[] = [];
    const skipped: { path: string; reason: 'missing' | 'too_large' | 'not_allowed' | 'batch_full' }[] = [];
    let bytes = 0;
    for (const path of paths.slice(0, OBSIDIAN_LIMITS.readBatch)) {
      let target: string;
      try {
        target = await confinedNotePath(root, path, 'read');
      } catch {
        skipped.push({ path, reason: 'not_allowed' });
        continue;
      }
      const info = await stat(target).catch(() => null);
      if (!info?.isFile()) {
        skipped.push({ path, reason: 'missing' });
        continue;
      }
      if (info.size > OBSIDIAN_LIMITS.noteBytes) {
        skipped.push({ path, reason: 'too_large' });
        continue;
      }
      if (bytes + info.size > OBSIDIAN_LIMITS.readBatchBytes) {
        skipped.push({ path, reason: 'batch_full' });
        continue;
      }
      const text = await readFile(target, 'utf8').catch(() => null);
      if (text === null) {
        skipped.push({ path, reason: 'missing' });
        continue;
      }
      bytes += info.size;
      notes.push({
        path,
        text: text.slice(0, OBSIDIAN_LIMITS.noteBytes),
        mtime: Math.floor(info.mtimeMs),
        size: info.size,
      });
    }
    return { notes, skipped };
  }

  private async head(target: string): Promise<string> {
    const handle = await open(target, 'r');
    try {
      const buffer = Buffer.alloc(MARKER_HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, MARKER_HEAD_BYTES, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  /**
   * Writes a note in the copilot's folder only. 'create' never replaces anything; 'overwrite' replaces a note only
   * when its front matter carries the marker, so the user's own notes are left alone. The new text goes to a hidden
   * file in the same folder first and is renamed into place, so a note is never left half written.
   */
  async write(
    vaultId: string,
    request: { path: string; text: string; mode: 'create' | 'overwrite' },
  ): Promise<{ path: string; mtime: number; created: boolean }> {
    requireWriteRoot(request.path);
    if (Buffer.byteLength(request.text, 'utf8') > OBSIDIAN_LIMITS.noteBytes)
      fail('invalid', 'That note is too large to write.');
    const root = await this.root(vaultId);
    const target = await confinedNotePath(root, request.path, 'write');
    const existing = await lstat(target).catch(() => null);
    if (existing && request.mode === 'create') fail('invalid', 'A note already exists at that path.');
    if (existing && !carriesMarker(await this.head(target))) {
      fail('forbidden', 'That note is not one Ava Copilot wrote, so it was left alone.');
    }
    await mkdir(dirname(target), { recursive: true });
    // The folders made must still be inside the vault, with no link on the way
    await confinedNotePath(root, request.path, 'write');
    if (!existing) {
      try {
        await writeFile(target, request.text, { flag: 'wx', mode: 0o644 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('invalid', 'A note already exists at that path.');
        throw error;
      }
    } else {
      const temp = join(dirname(target), `.${basename(target)}.nex-${randomBytes(6).toString('hex')}`);
      try {
        await writeFile(temp, request.text, { flag: 'wx', mode: 0o644 });
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        throw error;
      }
    }
    this.walked = null;
    const info = await stat(target);
    return { path: request.path, mtime: Math.floor(info.mtimeMs), created: !existing };
  }

  /** Removes a note only when it carries the marker. */
  async remove(vaultId: string, path: string): Promise<boolean> {
    requireWriteRoot(path);
    const root = await this.root(vaultId);
    const target = await confinedNotePath(root, path, 'write');
    const info = await lstat(target).catch(() => null);
    if (!info) return false;
    if (!carriesMarker(await this.head(target))) {
      fail('forbidden', 'That note is not one Ava Copilot wrote, so it was left alone.');
    }
    await unlink(target);
    this.walked = null;
    return true;
  }

  /** Notes whose name or text holds the words, names first; reads at most OBSIDIAN_LIMITS.searchScanBytes. */
  async search(vaultId: string, query: string, limit: number) {
    const root = await this.root(vaultId);
    const { notes } = await this.walk(root);
    const needle = query.toLowerCase();
    const results: { path: string; title: string; snippet: string; mtime: number }[] = [];
    const title = (path: string) => basename(path).replace(/\.md$/i, '').slice(0, 300);
    for (const note of notes) {
      if (results.length >= limit) return { results, truncated: true };
      if (note.path.toLowerCase().includes(needle))
        results.push({ path: note.path, title: title(note.path), snippet: '', mtime: note.mtime });
    }
    let scanned = 0;
    const named = new Set(results.map(result => result.path));
    for (const note of notes) {
      if (named.has(note.path) || note.size > OBSIDIAN_LIMITS.noteBytes) continue;
      if (results.length >= limit) return { results, truncated: true };
      if (scanned + note.size > OBSIDIAN_LIMITS.searchScanBytes) return { results, truncated: true };
      scanned += note.size;
      let text: string;
      try {
        text = await readFile(await confinedNotePath(root, note.path, 'read'), 'utf8');
      } catch (error) {
        if (!AppError.isInstance(error) && !isMissing(error)) this.deps.log.debug('A note could not be searched');
        continue;
      }
      const at = text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const snippet = text
        .slice(Math.max(0, at - 150), at + needle.length + 150)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400);
      results.push({ path: note.path, title: title(note.path), snippet, mtime: note.mtime });
    }
    return { results, truncated: false };
  }
}
