/**
 * switch_account for CLIs: read the current account, switch, verify. GitHub wraps `gh-switch` (gh auth and the
 * global git identity together); Vercel wraps `vercel-switch` (saved login snapshots). Both scripts live in
 * ~/.local/bin and already decide how to switch; this file only calls them, parses names, and verifies.
 * Nothing here reads a token: account names and Vercel user ids only.
 */
import { join } from 'node:path';
import type { ProcessResult, ProcessRunner } from '../sandbox/process';
import { redactSecrets } from '../security/secrets';

export type AccountTool = 'gh' | 'vercel';

export interface SwitchRequest {
  tool: AccountTool;
  // Exact account name; omit (with no repo) to only read the current account
  account?: string;
  // Absolute repo folder: pick the right account for it (gh-switch --for-repo / vercel-switch --for-repo)
  repo?: string;
  purpose: string;
  agent: string;
}

export interface SwitchResult {
  tool: AccountTool;
  from: string | null;
  to: string | null;
  switched: boolean;
  verified: boolean;
  accounts: string[];
  gitEmail?: string;
  message: string;
}

export interface AccountDeps {
  runner: ProcessRunner;
  home: string;
  notify?: (title: string, text: string) => Promise<void>;
}

const ANSI = /\u001b\[[0-9;]*m/g;
const plain = (r: ProcessResult) => `${r.stdout}\n${r.stderr}`.replace(ANSI, '');

export function accountEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: home,
    LANG: 'en_US.UTF-8',
    NO_COLOR: '1',
    GH_PROMPT_DISABLED: '1',
  };
}

/** `gh auth status` -> { active, accounts } (account logins only; the token line is never read). */
export function parseGhStatus(text: string): { active: string | null; accounts: string[] } {
  const accounts: string[] = [];
  let active: string | null = null;
  let last: string | null = null;
  for (const line of text.split('\n')) {
    const login = /Logged in to github\.com account (\S+)/.exec(line)?.[1];
    if (login) {
      accounts.push(login);
      last = login;
    } else if (last && /Active account: true/.test(line)) active = last;
  }
  return { active, accounts };
}

/** `vercel-switch --list` -> { name: userId }; `vercel-switch` -> the active userId. */
export function parseVercelList(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^\s{2}(\S+)\s+userId (\S+)/.exec(line);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}
export const parseVercelActive = (text: string): string | null => /userId\s+(\S+)/.exec(text)?.[1] ?? null;

const nameOf = (saved: Map<string, string>, userId: string | null) =>
  userId ? ([...saved].find(([, id]) => id === userId)?.[0] ?? null) : null;

async function ghState(deps: AccountDeps) {
  const r = await deps.runner('gh', ['auth', 'status'], { env: accountEnv(deps.home), timeoutMs: 20_000 });
  return parseGhStatus(plain(r));
}

async function vercelState(deps: AccountDeps) {
  const env = accountEnv(deps.home);
  const list = parseVercelList(plain(await deps.runner('vercel-switch', ['--list'], { env, timeoutMs: 20_000 })));
  const activeId = parseVercelActive(plain(await deps.runner('vercel-switch', [], { env, timeoutMs: 20_000 })));
  return { saved: list, activeId, active: nameOf(list, activeId) };
}

const tidy = (text: string) => redactSecrets(text.trim().split('\n').slice(-2).join(' ').slice(0, 300)).text;

export async function switchAccount(req: SwitchRequest, deps: AccountDeps): Promise<SwitchResult> {
  if (req.account && req.repo) throw new Error('give an account or a repo, not both');
  if (req.account && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/.test(req.account)) throw new Error('account names are letters, digits, . _ - only');
  if (req.repo && !req.repo.startsWith('/')) throw new Error('repo must be an absolute folder');
  const env = accountEnv(deps.home);
  const notify = async (to: string) => {
    try {
      await deps.notify?.(`Ava: ${req.agent} switched ${req.tool}`, `Now ${to}. ${req.purpose}`);
    } catch {
      // a notification is a courtesy, never a failure
    }
  };

  if (req.tool === 'gh') {
    const before = await ghState(deps);
    const base = { tool: 'gh' as const, from: before.active, accounts: before.accounts };
    if (!req.account && !req.repo) {
      return { ...base, to: before.active, switched: false, verified: before.active !== null, message: `GitHub is on ${before.active ?? 'no account'}` };
    }
    if (req.account && !before.accounts.includes(req.account)) {
      return { ...base, to: before.active, switched: false, verified: false, message: `${req.account} is not signed in to gh here (signed in: ${before.accounts.join(', ') || 'none'}). Ask Avi to run \`gh auth login\` for it.` };
    }
    if (req.account === before.active) {
      return { ...base, to: before.active, switched: false, verified: true, message: `GitHub is already on ${before.active}` };
    }
    const ran = await deps.runner('gh-switch', req.account ? [req.account] : ['--for-repo'], { env, timeoutMs: 60_000, cwd: req.repo });
    if (ran.code !== 0) return { ...base, to: before.active, switched: false, verified: false, message: `gh-switch failed: ${tidy(plain(ran))}` };
    const after = await ghState(deps);
    // The account GitHub itself answers as, not only what the keyring says
    const who = (await deps.runner('gh', ['api', 'user', '--jq', '.login'], { env, timeoutMs: 20_000 })).stdout.trim();
    const email = (await deps.runner('git', ['config', '--global', 'user.email'], { env, timeoutMs: 10_000 })).stdout.trim();
    const wanted = req.account ?? after.active;
    const verified = !!wanted && after.active === wanted && who === wanted;
    if (after.active !== before.active && after.active) await notify(after.active);
    return {
      ...base,
      to: after.active,
      switched: after.active !== before.active,
      verified,
      gitEmail: email || undefined,
      message: verified ? `GitHub is on ${after.active} (commits as ${email})` : `switched, but GitHub answers as ${who || 'nobody'}; check \`gh auth status\``,
    };
  }

  const before = await vercelState(deps);
  const accounts = [...before.saved.keys()];
  const base = { tool: 'vercel' as const, from: before.active ?? (before.activeId ? 'an unsaved login' : null), accounts };
  if (!req.account && !req.repo) {
    return { ...base, to: base.from, switched: false, verified: before.active !== null, message: `Vercel is on ${base.from ?? 'no login'}` };
  }
  // vercel-switch overwrites the active login: an unsaved one would be gone until Avi signs in again in a browser
  if (before.activeId && !before.active) {
    return { ...base, to: base.from, switched: false, verified: false, message: 'the active Vercel login is not saved, so switching would lose it. Ask Avi to run `vercel-switch --save <name>` first.' };
  }
  if (req.account && !before.saved.has(req.account)) {
    return { ...base, to: base.from, switched: false, verified: false, message: `no saved Vercel login named ${req.account} (saved: ${accounts.join(', ') || 'none'})` };
  }
  // Re-activating the same login would copy an older snapshot over a freshly refreshed token
  if (req.account && req.account === before.active) {
    return { ...base, to: before.active, switched: false, verified: true, message: `Vercel is already on ${before.active}` };
  }
  const ran = await deps.runner('vercel-switch', req.account ? [req.account] : ['--for-repo'], { env, timeoutMs: 30_000, cwd: req.repo });
  if (ran.code !== 0) return { ...base, to: base.from, switched: false, verified: false, message: `vercel-switch could not pick a login: ${tidy(plain(ran))}` };
  const after = await vercelState(deps);
  const verified = !!after.active && (!req.account || after.active === req.account);
  if (after.active && after.active !== before.active) await notify(after.active);
  return {
    ...base,
    to: after.active,
    switched: after.active !== before.active,
    verified,
    message: verified ? `Vercel is on ${after.active}` : 'vercel-switch ran but the active login is not the one asked for',
  };
}
