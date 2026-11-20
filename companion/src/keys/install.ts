/**
 * `ava-brain keys install`: put the masker at ~/.ava-keys/mask and register the Ava Keys MCP server with the
 * coding agents on this Mac (v0: Claude Code). Idempotent; prints what it did, never a value.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProcessRunner } from '../sandbox/process';
import { VAULT_BIN } from './run';

export const MCP_NAME = 'ava-keys';

export const maskPathOf = (home: string = homedir()) => join(home, '.ava-keys', 'mask');
export const maskSourceOf = (packageDir: string) => join(packageDir, 'dist', 'ava-keys-mask.mjs');

/**
 * A node path that survives upgrades: Homebrew's /opt/homebrew/bin/node when it is this node, since
 * process.execPath is the versioned Cellar path that disappears on the next `brew upgrade`.
 */
export function stableNode(execPath: string = process.execPath, candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node']): string {
  try {
    const real = realpathSync(execPath);
    for (const candidate of candidates) if (existsSync(candidate) && realpathSync(candidate) === real) return candidate;
  } catch {
    // fall through
  }
  return execPath;
}

/** The masker file: a `#!` line to this node, then the bundled masker. */
export function maskerContent(source: string, nodePath: string): string {
  return `#!${nodePath}\n${source.replace(/^#!.*\n/, '')}`;
}

export const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

/** Write the masker if it is missing or different; returns its hash. The folder is 0700, the file 0500. */
export function ensureMasker(opts: { packageDir: string; nodePath: string; home?: string }): { path: string; hash: string; wrote: boolean } {
  const path = maskPathOf(opts.home);
  const sourcePath = maskSourceOf(opts.packageDir);
  if (!existsSync(sourcePath)) throw new Error(`${sourcePath} is missing: build Ava Brain first (npm run build in companion)`);
  const content = maskerContent(readFileSync(sourcePath, 'utf8'), opts.nodePath);
  const hash = sha256(content);
  if (existsSync(path) && sha256(readFileSync(path)) === hash) return { path, hash, wrote: false };
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (existsSync(path)) chmodSync(path, 0o700);
  writeFileSync(path, content, { mode: 0o500 });
  chmodSync(path, 0o500);
  return { path, hash, wrote: true };
}

/** Is offboard's vault installed root-owned (the only place Ava Keys gets values from)? */
export function vaultInstalled(bin: string = VAULT_BIN): boolean {
  try {
    const st = statSync(bin);
    return st.isFile() && st.uid === 0;
  } catch {
    return false;
  }
}

/** The command an agent starts: this node running this Ava Brain bundle with `keys-mcp`. */
export function serverCommand(nodePath: string, packageDir: string): string[] {
  return [nodePath, join(packageDir, 'dist', 'nex-brain.mjs'), 'keys-mcp'];
}

export function findClaude(home: string = homedir()): string | null {
  for (const path of [join(home, '.local', 'bin', 'claude'), join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    if (existsSync(path)) return path;
  }
  return null;
}

/** Register with Claude Code at user scope, replacing an older ava-keys entry. */
export async function registerClaude(
  runner: ProcessRunner,
  opts: { claude: string; command: string[]; home: string },
): Promise<string> {
  const env = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: opts.home, LANG: 'en_US.UTF-8', NO_COLOR: '1' };
  const existing = await runner(opts.claude, ['mcp', 'get', MCP_NAME], { env, timeoutMs: 30_000 });
  if (existing.code === 0) await runner(opts.claude, ['mcp', 'remove', '--scope', 'user', MCP_NAME], { env, timeoutMs: 30_000 });
  const added = await runner(opts.claude, ['mcp', 'add', '--scope', 'user', MCP_NAME, '--', ...opts.command], { env, timeoutMs: 30_000 });
  if (added.code !== 0) throw new Error(`claude mcp add failed: ${added.stderr.trim().slice(0, 300) || `exit ${added.code}`}`);
  return existing.code === 0 ? 'Claude Code: replaced the ava-keys MCP server (user scope)' : 'Claude Code: added the ava-keys MCP server (user scope)';
}
