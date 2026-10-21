import { lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { isSafeNotePath } from '@protocol';
import { fail } from '../errors';

/**
 * Keeps every file operation inside the vault the user chose. A vault root is an existing directory with an
 * `.obsidian/` folder, resolved with realpath; a note path is relative, ends in .md and has no "..", hidden or
 * empty parts; and no symlink on the way may lead outside the root. Writes never go through a symlink at all.
 */

export function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

// System folders that are never a vault, nor anything inside them. macOS's temporary folders are under /private.
export const SYSTEM_ROOTS = ['/System', '/Library', '/private', '/etc', '/var', '/usr', '/bin', '/sbin', '/opt'];

/**
 * Why a resolved folder may not be a vault root, or null. Refused: the disk, the home folder and every folder above
 * it (e.g. /Users), ~/Library and everything in it, the system folders, and any hidden folder (~/.ssh …). Both paths
 * are real paths. Exported for tests.
 */
export function refusedVaultRoot(real: string, realHome: string, systemRoots: string[] = SYSTEM_ROOTS): string | null {
  if (real === sep || isInside(real, realHome)) {
    return 'Choose the vault folder itself, not your whole disk or home folder.';
  }
  if (isInside(join(realHome, 'Library'), real)) return 'A folder in ~/Library cannot be a vault.';
  if (systemRoots.some(root => isInside(root, real))) return 'A system folder cannot be a vault.';
  if (real.split(sep).some(part => part.startsWith('.'))) return 'A hidden folder cannot be a vault.';
  return null;
}

/**
 * The vault folder a user typed or Obsidian lists, resolved and checked. Throws a plain sentence otherwise.
 * `systemRoots` is only narrowed by tests, whose temporary folders live under /private.
 */
export async function resolveVaultRoot(
  input: string,
  home: string = homedir(),
  systemRoots: string[] = SYSTEM_ROOTS,
): Promise<string> {
  const typed = input.trim();
  if (!typed || typed.includes('\0')) fail('invalid', 'Type the full path of your vault folder.');
  const expanded = typed === '~' ? home : typed.startsWith('~/') ? join(home, typed.slice(2)) : typed;
  if (!isAbsolute(expanded)) fail('invalid', 'Type the full path of your vault folder, starting with / or ~/.');
  let real: string;
  try {
    real = await realpath(resolve(expanded));
  } catch {
    fail('not_found', 'That folder does not exist on this Mac.');
  }
  const info = await stat(real).catch(() => null);
  if (!info?.isDirectory()) fail('invalid', 'That is a file, not a folder.');
  // A home reached through a symlink compares as its real path
  const realHome = await realpath(resolve(home)).catch(() => resolve(home));
  const refused = refusedVaultRoot(real, realHome, systemRoots);
  if (refused) fail('invalid', refused);
  const config = await lstat(join(real, '.obsidian')).catch(() => null);
  if (!config?.isDirectory()) {
    fail(
      'invalid',
      'That folder is not an Obsidian vault (it has no .obsidian folder). Open it in Obsidian once, then try again.',
    );
  }
  return real;
}

/** Whether a folder is (still) a usable vault, without throwing. */
export async function isVault(
  path: string,
  home: string = homedir(),
  systemRoots: string[] = SYSTEM_ROOTS,
): Promise<string | null> {
  try {
    return await resolveVaultRoot(path, home, systemRoots);
  } catch {
    return null;
  }
}

/**
 * The absolute path of a note inside the root, after every check. For 'read' a symlink is followed only when its
 * target stays inside the root; for 'write' no part of the path may be a symlink. Folders that do not exist yet
 * are fine for a write (they are made), and make a read "missing".
 */
export async function confinedNotePath(root: string, relative: string, purpose: 'read' | 'write'): Promise<string> {
  if (!isSafeNotePath(relative)) fail('invalid', 'That is not a Markdown note inside the vault.');
  const parts = relative.split('/');
  const target = join(root, ...parts);
  if (!isInside(root, target) || target === root) fail('forbidden', 'That path leaves the vault.');

  let folder = root;
  for (const part of parts.slice(0, -1)) {
    folder = join(folder, part);
    const info = await lstat(folder).catch(() => null);
    if (!info) break;
    if (info.isSymbolicLink()) {
      if (purpose === 'write') fail('forbidden', 'Nex Brain does not write through a linked folder.');
      const real = await realpath(folder).catch(() => null);
      if (!real || !isInside(root, real)) fail('forbidden', 'That path leaves the vault.');
    } else if (!info.isDirectory()) {
      fail('invalid', 'Part of that path is a file, not a folder.');
    }
  }

  const info = await lstat(target).catch(() => null);
  if (info?.isSymbolicLink()) {
    if (purpose === 'write') fail('forbidden', 'Nex Brain does not write through a linked file.');
    const real = await realpath(target).catch(() => null);
    if (!real || !isInside(root, real)) fail('forbidden', 'That path leaves the vault.');
  }
  if (info && !info.isSymbolicLink() && !info.isFile()) fail('invalid', 'That path is a folder, not a note.');
  if (purpose === 'read' && info) {
    // The final answer for a read: wherever the path leads must be inside the vault
    const real = await realpath(target).catch(() => null);
    if (!real || !isInside(root, real)) fail('forbidden', 'That path leaves the vault.');
  }
  return target;
}
