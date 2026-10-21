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

/** The vault folder a user typed or Obsidian lists, resolved and checked. Throws a plain sentence otherwise. */
export async function resolveVaultRoot(input: string, home: string = homedir()): Promise<string> {
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
  if (real === sep || real === resolve(home))
    fail('invalid', 'Choose the vault folder itself, not your whole disk or home folder.');
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
export async function isVault(path: string, home: string = homedir()): Promise<string | null> {
  try {
    return await resolveVaultRoot(path, home);
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
