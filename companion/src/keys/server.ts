/**
 * Ava Keys MCP server (stdio): `ava-brain keys-mcp`. Tools: run_with_secrets, ask_human, switch_account.
 * Results are JSON text with names, counts and masked output; never a secret value. stdout is the MCP channel,
 * so nothing else here writes to it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { ProcessRunner } from '../sandbox/process';
import { switchAccount } from './accounts';
import { askHuman, notifyAvi } from './ask';
import { ensureMasker } from './install';
import { runWithSecrets } from './run';

export interface KeysServerDeps {
  runner: ProcessRunner;
  packageDir: string;
  nodePath: string;
  home: string;
  version: string;
}

/** The MCP client's own name (e.g. "claude-code"), cleaned for the approval prompt. */
export function agentName(raw: string | undefined): string {
  const name = (raw ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  return name || 'an-agent';
}

const text = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

export function createKeysServer(deps: KeysServerDeps): McpServer {
  const server = new McpServer({ name: 'ava-keys', version: deps.version });
  const agent = () => agentName(server.server.getClientVersion()?.name);

  server.registerTool(
    'run_with_secrets',
    {
      title: 'Run a command with secrets from Avi’s vault',
      description:
        'Runs one command (argv, no shell) with the secrets of a vault project/env in its environment. Avi approves every call with ' +
        'Touch ID; the prompt shows your name, the purpose, the project/env and the exact command. Output comes back with every ' +
        'secret value replaced by «NAME». You never receive a value. Keep purpose and command short: offboard refuses an approval ' +
        'prompt over 200 characters, so keep arguments short too. Reference secrets inside the command by reading them ' +
        'from the environment in your program, not by passing them as arguments.',
      inputSchema: {
        project: z.string().min(1).max(40).describe('Vault project, e.g. go-solar-me'),
        env: z.string().min(1).max(30).describe('Vault env label, e.g. local'),
        only: z.array(z.string().min(1)).max(20).optional().describe('Only these secret names (default: all of project/env)'),
        command: z.string().min(1).describe('Program name on PATH or absolute path, e.g. pnpm or /usr/bin/printenv'),
        args: z.array(z.string()).max(20).optional().describe('Arguments, one per item'),
        cwd: z.string().optional().describe('Absolute folder to run in (default: home)'),
        purpose: z.string().min(3).max(48).describe('Why, in a few words, plain characters (no quotes or backslashes). Shown to Avi in the Touch ID prompt.'),
        timeout_seconds: z.number().int().min(10).max(1800).optional().describe('Includes the time Avi takes to approve (default 600)'),
      },
    },
    async input => {
      try {
        const masker = ensureMasker({ packageDir: deps.packageDir, nodePath: deps.nodePath, home: deps.home });
        const result = await runWithSecrets(
          {
            project: input.project,
            env: input.env,
            only: input.only,
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            purpose: input.purpose,
            agent: agent(),
            timeoutSeconds: input.timeout_seconds,
          },
          { runner: deps.runner, maskPath: masker.path, expectedMaskHash: masker.hash, home: deps.home },
        );
        return text(result, !result.approved);
      } catch (error) {
        return text({ approved: false, ran: false, message: (error as Error).message }, true);
      }
    },
  );

  server.registerTool(
    'ask_human',
    {
      title: 'Ask Avi to do something by hand',
      description:
        'Shows Avi numbered steps (a macOS notification and a dialog) and waits until he presses Done or I can’t. Use it for ' +
        'what only he can do: 2FA codes, CAPTCHAs, payments, a sign-in. One action per step, plain words, no jargon. Never ask ' +
        'him to paste or type a secret anywhere you can read it.',
      inputSchema: {
        purpose: z.string().min(3).max(120).describe('What this is for, one sentence'),
        steps: z
          .array(
            z.object({
              text: z.string().min(1).max(140).describe('One action, e.g. "Click the green Continue button"'),
              target: z.string().max(200).optional().describe('What a pointer should point at (later versions); optional'),
            }),
          )
          .min(1)
          .max(10),
        timeout_seconds: z.number().int().min(15).max(1800).optional().describe('How long to wait (default 600)'),
      },
    },
    async input => {
      try {
        const result = await askHuman({ purpose: input.purpose, steps: input.steps, agent: agent(), timeoutSeconds: input.timeout_seconds }, deps.runner);
        return text(result);
      } catch (error) {
        return text({ answer: 'error', message: (error as Error).message }, true);
      }
    },
  );

  server.registerTool(
    'switch_account',
    {
      title: 'Read or switch the gh or vercel account',
      description:
        'Reads the account a CLI is signed in as, or switches it and verifies. gh: switches gh auth and the global git commit ' +
        'identity together (gh-switch); with `repo` it picks the right account for that repo, also aligns Vercel (reported under `vercel`), and checks the commit email that repo uses. vercel: ' +
        'activates a saved Vercel login (vercel-switch). Omit account and repo to only read the current one. Names only, never ' +
        'tokens. Avi gets a notification when an account changes. An account that is not signed in comes back unswitched: ' +
        'then use ask_human to have Avi sign in.',
      inputSchema: {
        tool: z.enum(['gh', 'vercel']),
        account: z.string().min(1).max(39).optional().describe('Exact account name (gh login, or saved Vercel login name)'),
        repo: z.string().optional().describe('Absolute repo folder: switch to the account that repo needs'),
        purpose: z.string().min(3).max(120).describe('Why, in a few words (shown in the notification)'),
      },
    },
    async input => {
      try {
        const result = await switchAccount(
          { tool: input.tool, account: input.account, repo: input.repo, purpose: input.purpose, agent: agent() },
          { runner: deps.runner, home: deps.home, notify: (title, body) => notifyAvi(title, body, deps.runner) },
        );
        return text(result, !result.verified);
      } catch (error) {
        return text({ verified: false, message: (error as Error).message }, true);
      }
    },
  );

  return server;
}

export async function serveKeys(deps: KeysServerDeps): Promise<void> {
  const server = createKeysServer(deps);
  await server.connect(new StdioServerTransport());
}
