/**
 * run_with_secrets: start `offboard-vault run ... -- ~/.ava-keys/mask "<agent>: <purpose>" <command>`.
 * offboard-vault asks for Touch ID on every call and starts the masker with the values in its environment; the
 * masker prints masked JSON. This side never holds a value: it reads names from the vault and masked text back.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { ProcessRunner } from '../sandbox/process';
import { redactSecrets } from '../security/secrets';
import { MASK_MARKER, type MaskReport } from './mask-core';

export const VAULT_BIN = '/usr/local/bin/offboard-vault';
// offboard's limits for the approval prompt (lib/vault.mjs MAX_REASON, MAX_CMD)
export const MAX_REASON = 200;
export const MAX_CMD = 150;
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// A purpose is shown inside a quoted prompt argument: no quotes or backslashes that could make it read as more arguments
export const PURPOSE = /^[\p{L}\p{N} .,:;!?'()\/+&@#%_-]+$/u;
// The masker caps output at 400 KB; JSON escaping can grow that up to 6 times
const MAX_VAULT_OUTPUT = 3_000_000;

export interface RunRequest {
  project: string;
  env: string;
  only?: string[];
  command: string;
  args?: string[];
  cwd?: string;
  purpose: string;
  agent: string;
  timeoutSeconds?: number;
}

export interface RunResult {
  approved: boolean;
  ran: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  masked: Record<string, number>;
  unmasked: string[];
  redacted: string[];
  truncated: boolean;
  timedOut: boolean;
  message: string;
}

export interface RunDeps {
  runner: ProcessRunner;
  maskPath: string;
  expectedMaskHash: string;
  vaultBin?: string;
  searchPath?: string;
  home?: string;
}

/** The vault's names: { "project/env": [NAME, ...] }, from `offboard-vault list` (keyless, no prompt, no values). */
export function parseList(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let head: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim() || /^\d+ names$/.test(line) || line.startsWith('vault is empty')) continue;
    if (!line.startsWith(' ')) {
      head = line.trim();
      out.set(head, []);
    } else if (head) {
      const name = line.trim().split(/\s+/)[0];
      if (name) out.get(head)!.push(name);
    }
  }
  return out;
}

/** The environment offboard-vault starts with: no NODE_*, DYLD_* or LD_* (its helper refuses those), no secrets. */
export function vaultEnv(home: string, cwd: string): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin',
    HOME: home,
    LANG: 'en_US.UTF-8',
    NO_COLOR: '1',
    TERM: 'dumb',
    PWD: cwd,
  };
}

/** cmd as an absolute path: given with a "/" -> must be absolute; otherwise the first executable on PATH. */
export function resolveCommand(command: string, searchPath: string): string {
  if (command.includes('/')) {
    if (!isAbsolute(command)) throw new Error(`give the command as a name or an absolute path, not ${command}`);
    return command;
  }
  for (const dir of searchPath.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const file = join(dir, command);
    try {
      const st = statSync(file);
      if (st.isFile() && st.mode & 0o111) return file;
    } catch {
      // next
    }
  }
  throw new Error(`${command}: command not found`);
}

/** What the approval prompt will say; throws when offboard would refuse it, before any prompt. */
export function promptLine(maskPath: string, label: string, exe: string, args: string[]): string {
  const parts = [maskPath, label, exe, ...args];
  for (const part of parts) if (UNSAFE.test(part)) throw new Error('the command contains control or invisible characters');
  return parts.map(part => JSON.stringify(part)).join(' ');
}

export function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const refuse = (message: string): RunResult => ({
  approved: false,
  ran: false,
  exitCode: null,
  stdout: '',
  stderr: '',
  masked: {},
  unmasked: [],
  redacted: [],
  truncated: false,
  timedOut: false,
  message,
});

export async function runWithSecrets(req: RunRequest, deps: RunDeps): Promise<RunResult> {
  const vault = deps.vaultBin ?? VAULT_BIN;
  const home = deps.home ?? process.env.HOME ?? '/';
  const cwd = req.cwd ?? home;
  if (!PURPOSE.test(req.purpose)) return refuse('purpose may use letters, digits, spaces and . , : ; ! ? \' ( ) / + & @ # % _ - only');
  if (!isAbsolute(cwd)) return refuse('cwd must be an absolute path');
  try {
    if (!statSync(cwd).isDirectory()) return refuse(`cwd is not a folder: ${cwd}`);
  } catch {
    return refuse(`cwd does not exist: ${cwd}`);
  }
  try {
    if (fileHash(deps.maskPath) !== deps.expectedMaskHash) {
      return refuse(`${deps.maskPath} is not the masker this Ava Brain ships (changed on disk). Run \`ava-brain keys install\` again.`);
    }
  } catch {
    return refuse(`the masker is not installed at ${deps.maskPath}. Run \`ava-brain keys install\`.`);
  }

  // Names only: check project/env and --only before Avi sees a prompt
  const list = await deps.runner(vault, ['list', req.project], { env: vaultEnv(home, cwd), timeoutMs: 20_000, cwd });
  if (list.code !== 0) return refuse(`offboard-vault list failed: ${list.stderr.trim().slice(0, 300) || `exit ${list.code}`}`);
  const names = parseList(list.stdout).get(`${req.project}/${req.env}`);
  if (!names?.length) return refuse(`nothing stored for project=${req.project} env=${req.env}`);
  const only = req.only?.length ? req.only : undefined;
  if (only) {
    const missing = only.filter(name => !names.includes(name));
    if (missing.length) return refuse(`not in ${req.project}/${req.env}: ${missing.join(', ')}`);
  }
  const count = only?.length ?? names.length;

  let exe: string;
  let line: string;
  const label = `${req.agent}: ${req.purpose}`;
  try {
    exe = resolveCommand(req.command, deps.searchPath ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
    line = promptLine(deps.maskPath, label, exe, req.args ?? []);
  } catch (error) {
    return refuse((error as Error).message);
  }
  const reason = `Run with ${count} secrets of project=${req.project} env=${req.env}: ${line}`;
  if (line.length > MAX_CMD || reason.length > MAX_REASON) {
    return refuse(
      `the approval prompt would be too long (command part ${line.length}/${MAX_CMD}, whole ${reason.length}/${MAX_REASON}). ` +
        'Shorten the purpose or the arguments; Avi has to be able to read the whole command.',
    );
  }

  const argv = ['run', '--project', req.project, '--env', req.env, ...(only ? ['--only', only.join(',')] : []), '--', deps.maskPath, label, exe, ...(req.args ?? [])];
  const timeoutMs = Math.min(Math.max(req.timeoutSeconds ?? 600, 10), 1800) * 1000;
  const result = await deps.runner(vault, argv, { env: vaultEnv(home, cwd), timeoutMs, cwd, maxOutputBytes: MAX_VAULT_OUTPUT });

  const report = parseReport(result.stdout);
  if (!report && hasStarted(result.stdout)) {
    // Approved and started, but the report was lost (time limit or output cap). Never say "nothing ran" here: the
    // agent might run it again (a second deploy).
    return {
      ...refuse(`approved and started, but the result was lost (${result.timedOut ? 'time limit reached; the command was stopped' : 'too much output'}). Check its effect before running it again.`),
      approved: true,
      ran: true,
      timedOut: result.timedOut,
      truncated: result.truncated,
    };
  }
  if (!report) {
    // The masker never ran: denied, cancelled, or offboard refused. Only offboard's own "vault:" lines are passed on,
    // and those through the secret scan too.
    const why = redactSecrets(
      result.stderr
        .split('\n')
        .filter(line => line.startsWith('vault:'))
        .slice(-3)
        .join(' ')
        .slice(0, 400),
    ).text;
    const denied = /denied|cancel|not approved/i.test(why);
    return {
      ...refuse(result.timedOut ? 'no answer to the Touch ID prompt in time; nothing ran' : denied ? `Avi did not approve; nothing ran (${why})` : `nothing ran: ${why || `offboard-vault exit ${result.code}`}`),
      timedOut: result.timedOut,
    };
  }
  const out = redactSecrets(report.stdout);
  const err = redactSecrets(report.stderr);
  return {
    approved: true,
    ran: !report.error,
    exitCode: report.exitCode,
    stdout: out.text,
    stderr: err.text,
    masked: report.masked,
    unmasked: report.unmasked,
    redacted: [...new Set([...out.kinds, ...err.kinds])],
    truncated: report.truncated || result.truncated,
    timedOut: report.timedOut || result.timedOut,
    message: report.error ?? (report.exitCode === 0 ? 'ran, exit 0' : `ran, exit ${report.exitCode}`),
  };
}

/** The masker's JSON line (the last line on stdout that carries its marker), or null when it never ran. */
export function parseReport(stdout: string): MaskReport | null {
  const lines = stdout.trim().split('\n').reverse();
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line) as MaskReport;
      if (value.marker === MASK_MARKER && !value.started) return value;
    } catch {
      // not ours
    }
  }
  return null;
}

/** Did the masker get as far as starting the command? (its first line) */
export function hasStarted(stdout: string): boolean {
  return stdout.split('\n').some(line => line.startsWith('{') && line.includes(MASK_MARKER) && line.includes('"started":true'));
}
