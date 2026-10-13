import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { COMPANION_TOOL_NAMES, relativePathSchema } from '@protocol';
import type { CompanionToolName } from '@protocol';
import type { ArtifactStore } from '../artifacts/store';
import { classifyGh } from '../cli/gh';
import type { GhRunner } from '../cli/gh';
import { fail } from '../errors';
import type { McpManager } from '../mcp/manager';
import type { SandboxManager } from '../sandbox/manager';
import type { ProfileRegistry } from './registry';

/**
 * The tools an agent session may call, as Nex Brain runs them. The eve agent only forwards calls here
 * (agent/tools/avi.ts), so every rule lives in one place and is checked again whatever the agent says:
 * the profile must list the tool; files stay in the profile's workspace; gh reads stay reads; a write
 * reaches here only after the user's click (eve's approval, relayed from the extension's Inbox); MCP
 * tools must be on the profile's list, and read-only ones must be marked so by the user.
 *
 * `approved` is set by the forwarder only for a tool eve held for the user's click (never by the model), and is
 * checked here again: a profile changed after its session started cannot turn a held call into a free one.
 */

const inputs = {
  run_command: z.object({ command: z.string().trim().min(1).max(8000) }),
  read_file: z.object({ path: relativePathSchema }),
  write_file: z.object({ path: relativePathSchema, content: z.string().max(2_000_000) }),
  gh: z.object({ args: z.array(z.string().max(8000)).min(1).max(40) }),
  gh_write: z.object({ args: z.array(z.string().max(8000)).min(1).max(40) }),
  mcp_read: z.object({
    server: z.string().min(1).max(80),
    tool: z.string().min(1).max(200),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  mcp_call: z.object({
    server: z.string().min(1).max(80),
    tool: z.string().min(1).max(200),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  publish_artifact: z.object({
    title: z.string().trim().min(1).max(120),
    kind: z.enum(['html', 'svg', 'site']),
    files: z.record(relativePathSchema, z.string().max(2_000_000)).optional(),
    build: z.object({ command: z.string().trim().min(1).max(4000), outDir: relativePathSchema }).optional(),
    entry: relativePathSchema.default('index.html'),
  }),
} satisfies Record<CompanionToolName, z.ZodType>;

export interface ToolDeps {
  registry: ProfileRegistry;
  sandbox: SandboxManager;
  gh: GhRunner;
  mcp: McpManager;
  artifacts: ArtifactStore;
}

export function isToolName(name: string): name is CompanionToolName {
  return (COMPANION_TOOL_NAMES as readonly string[]).includes(name);
}

export async function runTool(
  deps: ToolDeps,
  name: CompanionToolName,
  profileId: string,
  rawInput: unknown,
  signal: AbortSignal,
  { approved = false }: { approved?: boolean } = {},
): Promise<unknown> {
  const profile = deps.registry.profile(profileId);
  if (!profile) fail('not_found', 'This agent is not known on the Mac; open Nex Copilot to send it again.');
  if (!profile.tools.includes(name)) fail('forbidden', `This agent may not use ${name}.`);
  const parsed = inputs[name].safeParse(rawInput);
  if (!parsed.success) fail('invalid', `The input for ${name} is not valid: ${parsed.error.issues[0]?.message ?? ''}`);

  switch (name) {
    case 'run_command': {
      const input = parsed.data as z.infer<typeof inputs.run_command>;
      if (profile.sandbox.network === 'open' && !approved) {
        fail('forbidden', 'A command with network access needs the user’s click first; it was not run.');
      }
      const result = await deps.sandbox.run({ profileId, command: input.command, policy: profile.sandbox, signal });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        truncated: result.truncated,
      };
    }
    case 'read_file': {
      const input = parsed.data as z.infer<typeof inputs.read_file>;
      return { path: input.path, content: await deps.sandbox.readFile(profileId, input.path) };
    }
    case 'write_file': {
      const input = parsed.data as z.infer<typeof inputs.write_file>;
      return { path: input.path, ...(await deps.sandbox.writeFile(profileId, input.path, input.content)) };
    }
    case 'gh': {
      const input = parsed.data as z.infer<typeof inputs.gh>;
      const check = classifyGh(input.args);
      if (check.ok && check.kind === 'write')
        fail('forbidden', 'That posts to GitHub; use gh_write, which asks the user first.');
      const result = await deps.gh.run(input.args, { approved: false, signal });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    }
    case 'gh_write': {
      const input = parsed.data as z.infer<typeof inputs.gh_write>;
      const check = classifyGh(input.args);
      if (check.ok && check.kind !== 'write') fail('invalid', 'That only reads; use gh.');
      // eve holds this call until the user approves it in Nex Copilot (approval: always())
      if (!approved) fail('forbidden', 'Posting to GitHub needs the user’s click first; nothing was posted.');
      const result = await deps.gh.run(input.args, { approved, signal });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    }
    case 'mcp_read':
    case 'mcp_call': {
      const input = parsed.data as z.infer<typeof inputs.mcp_call>;
      if (!profile.mcpTools.includes(`${input.server}/${input.tool}`)) {
        fail('forbidden', `This agent may not use ${input.server}/${input.tool}.`);
      }
      if (name === 'mcp_read' && !deps.mcp.isReadOnly(input.server, input.tool)) {
        fail('forbidden', `${input.tool} is not marked read-only; use mcp_call, which asks the user first.`);
      }
      if (name === 'mcp_call' && !approved) {
        fail('forbidden', `${input.tool} needs the user’s click first; it was not called.`);
      }
      const result = await deps.mcp.callTool(input.server, input.tool, input.args, { signal });
      return { isError: result.isError, content: result.content };
    }
    case 'publish_artifact': {
      const input = parsed.data as z.infer<typeof inputs.publish_artifact>;
      if (Boolean(input.files) === Boolean(input.build)) fail('invalid', 'Give either files or a build.');
      // A build runs a command: only an agent that may run commands builds, within its own sandbox limits
      if (input.build && !profile.tools.includes('run_command')) {
        fail('forbidden', 'This agent may not run commands, so it cannot build; give the files instead.');
      }
      const artifact = await deps.artifacts.create({
        requestId: randomBytes(8).toString('hex'),
        profileId,
        title: input.title,
        kind: input.kind,
        files: input.files,
        build: input.build,
        entry: input.entry,
        policy: profile.sandbox,
      });
      return { artifactId: artifact.id, title: artifact.title, files: artifact.files };
    }
  }
}
