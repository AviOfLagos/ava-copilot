/**
 * list_secrets and get_status: what the vault holds by name, and whether Ava Keys is ready. Names and booleans only;
 * no value is read, no Touch ID prompt is shown (`offboard-vault list` never decrypts).
 */
import { connect } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import type { ProcessRunner } from '../sandbox/process';
import { MCP_NAME, findClaude, maskPathOf, maskSourceOf, maskerContent, sha256, vaultInstalled } from './install';
import { VAULT_BIN, parseList, vaultEnv } from './run';

export interface SecretNames {
  /** { project: { env: [secret names] } } */
  projects: Record<string, Record<string, string[]>>;
  /** Set when the vault could not be read (not installed, locked out): `projects` is then empty */
  message?: string;
}

/** Projects, envs and secret names from `offboard-vault list`. */
export async function listSecrets(deps: {
  runner: ProcessRunner;
  home: string;
  vaultBin?: string;
}): Promise<SecretNames> {
  const result = await deps.runner(deps.vaultBin ?? VAULT_BIN, ['list'], {
    env: vaultEnv(deps.home, deps.home),
    timeoutMs: 20_000,
    cwd: deps.home,
  });
  if (result.code !== 0) {
    return {
      projects: {},
      message: `offboard-vault list failed: ${result.stderr.trim().slice(0, 200) || `exit ${result.code}`}`,
    };
  }
  const projects: SecretNames['projects'] = {};
  for (const [key, names] of parseList(result.stdout)) {
    const cut = key.lastIndexOf('/');
    if (cut <= 0) continue;
    (projects[key.slice(0, cut)] ??= {})[key.slice(cut + 1)] = names;
  }
  return { projects };
}

/** Is the masker on disk the one this Ava Brain ships? Reads only: unlike ensureMasker it never writes. */
export function maskerCurrent(opts: { packageDir: string; nodePath: string; home: string }): boolean {
  try {
    const source = maskSourceOf(opts.packageDir);
    const path = maskPathOf(opts.home);
    if (!existsSync(source) || !existsSync(path)) return false;
    return sha256(readFileSync(path)) === sha256(maskerContent(readFileSync(source, 'utf8'), opts.nodePath));
  } catch {
    return false;
  }
}

/** Does something answer on Ava Brain's port? A plain connect: no request, no token. */
export function portOpen(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export interface KeysStatus {
  brainUp: boolean;
  vaultInstalled: boolean;
  maskerCurrent: boolean;
  agents: { name: string; registered: boolean }[];
}

export interface StatusDeps {
  runner: ProcessRunner;
  packageDir: string;
  nodePath: string;
  home: string;
  /** Ava Brain's address, for the "is it up" check; defaults to the usual one */
  brain: { host: string; port: number };
  // Overridable in tests
  probe?: (host: string, port: number) => Promise<boolean>;
  vaultBin?: string;
  claudePath?: string | null;
}

export async function getStatus(deps: StatusDeps): Promise<KeysStatus> {
  const claude = deps.claudePath === undefined ? findClaude(deps.home) : deps.claudePath;
  let registered = false;
  if (claude) {
    const env = {
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
      HOME: deps.home,
      LANG: 'en_US.UTF-8',
      NO_COLOR: '1',
    };
    registered =
      (await deps.runner(claude, ['mcp', 'get', MCP_NAME], { env, timeoutMs: 20_000 }).catch(() => ({ code: 1 })))
        .code === 0;
  }
  return {
    brainUp: await (deps.probe ?? portOpen)(deps.brain.host, deps.brain.port),
    vaultInstalled: vaultInstalled(deps.vaultBin),
    maskerCurrent: maskerCurrent(deps),
    agents: [{ name: 'claude-code', registered }],
  };
}
