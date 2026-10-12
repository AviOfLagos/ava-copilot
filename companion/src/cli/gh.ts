import type { GhReply } from '@protocol';
import { AppError, fail } from '../errors';
import type { Logger } from '../log';
import { hostToolEnv } from '../sandbox/process';
import type { ProcessRunner } from '../sandbox/process';
import { describeFindings, scanForSecrets } from '../security/secrets';

/**
 * `gh` is the only program Avi Brain runs on the Mac itself, and only these subcommands of it:
 * reading issues, pull requests, runs and the repository freely; opening an issue or commenting only with
 * the user's click and a clean secret scan. Nothing that writes code (git push, gh repo create, pr create
 * or merge, releases, gh api) is on the list: those never run from here.
 */

export type GhKind = 'read' | 'write';

const READ: string[][] = [
  ['issue', 'list'],
  ['issue', 'view'],
  ['issue', 'status'],
  ['pr', 'list'],
  ['pr', 'view'],
  ['pr', 'diff'],
  ['pr', 'checks'],
  ['pr', 'status'],
  ['repo', 'view'],
  ['run', 'list'],
  ['run', 'view'],
  ['release', 'list'],
  ['release', 'view'],
  ['search', 'issues'],
  ['search', 'prs'],
];

const WRITE: string[][] = [
  ['issue', 'create'],
  ['issue', 'comment'],
  ['pr', 'comment'],
];

// Flags that read a file on the Mac, open a browser or an editor, or change where gh sends things
const FORBIDDEN_FLAGS = new Set([
  '--body-file',
  '-F',
  '--web',
  '-w',
  '--editor',
  '-e',
  '--template',
  '-T',
  '--recover',
  '--hostname',
]);

// Tabs and newlines are fine in a body; other control characters have no business in a gh argument
function hasControlCharacters(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
  }
  return false;
}

export type GhCheck = { ok: true; kind: GhKind } | { ok: false; reason: string };

/** Whether a gh command line is on the list, and whether it reads or writes. */
export function classifyGh(args: string[]): GhCheck {
  if (args.length < 2) return { ok: false, reason: 'Say which gh command to run, e.g. "issue list".' };
  const [group, action] = args;
  const kind: GhKind | null = READ.some(([g, a]) => g === group && a === action)
    ? 'read'
    : WRITE.some(([g, a]) => g === group && a === action)
      ? 'write'
      : null;
  if (!kind) return { ok: false, reason: `"gh ${group} ${action}" is not allowed from Avi Brain.` };
  for (const arg of args.slice(2)) {
    const flag = arg.split('=')[0];
    if (FORBIDDEN_FLAGS.has(flag)) return { ok: false, reason: `The flag ${flag} is not allowed from Avi Brain.` };
    if (hasControlCharacters(arg)) return { ok: false, reason: 'An argument has control characters.' };
  }
  return { ok: true, kind };
}

export interface GhRunner {
  run(args: string[], options: { approved: boolean; signal?: AbortSignal }): Promise<GhReply & { kind: GhKind }>;
}

export function createGhRunner(deps: { run: ProcessRunner; log: Logger }): GhRunner {
  return {
    async run(args, { approved, signal }) {
      const check = classifyGh(args);
      if (!check.ok) fail('forbidden', check.reason);
      if (check.kind === 'write') {
        if (!approved) fail('forbidden', 'This posts to GitHub, so it needs your click in Avi Copilot first.');
        const findings = scanForSecrets(args.slice(2).join('\n'));
        if (findings.length) fail('forbidden', describeFindings(findings));
      }
      const env = { ...hostToolEnv(), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1' };
      const result = await deps.run('gh', args, { env, timeoutMs: 60_000, maxOutputBytes: 1_000_000, signal });
      if (result.cancelled) throw new AppError('cancelled', 'Stopped.');
      if (result.timedOut) {
        // A write that timed out may still have happened
        throw new AppError(check.kind === 'write' ? 'unknown_outcome' : 'timeout', 'gh took longer than a minute.');
      }
      deps.log.info('gh', { command: `${args[0]} ${args[1]}`, exit: result.code });
      return { ok: true, kind: check.kind, exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
    },
  };
}
