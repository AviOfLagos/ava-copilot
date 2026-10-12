import { defineDynamic, defineTool } from 'eve/tools';
import { always } from 'eve/tools/approval';
import { z } from 'zod';
import { callAviBrain, loadProfile, profileIdOf } from '../lib/avi-brain';

/**
 * The session's tools: exactly the ones its profile lists. Each forwards to Avi Brain, which checks its
 * rules again. Calls that post or send outside the sandbox (gh_write, mcp_call, and commands when the
 * sandbox has network) wait for the user's approval, which Avi Copilot shows in its Inbox.
 */
export default defineDynamic({
  events: {
    'session.started': async (_event, ctx) => {
      const profile = await loadProfile(profileIdOf(ctx));
      const mcpList = profile.mcpTools.length ? profile.mcpTools.join(', ') : 'none';
      const tools = {
        run_command:
          profile.sandbox.network === 'open'
            ? defineTool({
                description:
                  'Run one shell command line in your sandbox (Linux, Node 24, pnpm, Python 3), in /workspace. It has network access, so the user approves each command.',
                inputSchema: z.object({ command: z.string().min(1).max(8000) }),
                approval: always(),
                execute: (input, toolCtx) => callAviBrain('run_command', input, toolCtx),
              })
            : defineTool({
                description:
                  'Run one shell command line in your sandbox (Linux, Node 24, pnpm, Python 3), in /workspace. No network, no secrets; files in /workspace persist.',
                inputSchema: z.object({ command: z.string().min(1).max(8000) }),
                execute: (input, toolCtx) => callAviBrain('run_command', input, toolCtx),
              }),
        read_file: defineTool({
          description: 'Read a text file from your sandbox workspace (a path relative to /workspace).',
          inputSchema: z.object({ path: z.string().min(1).max(240) }),
          execute: (input, toolCtx) => callAviBrain('read_file', input, toolCtx),
        }),
        write_file: defineTool({
          description:
            'Write a text file into your sandbox workspace (a path relative to /workspace), making its folders.',
          inputSchema: z.object({ path: z.string().min(1).max(240), content: z.string().max(2_000_000) }),
          execute: (input, toolCtx) => callAviBrain('write_file', input, toolCtx),
        }),
        gh: defineTool({
          description:
            'Read from GitHub with the gh CLI on the Mac: issue list/view, pr list/view/diff/checks, repo view, run list/view, release list/view, search issues/prs. Give the arguments after "gh", e.g. ["issue","list","--repo","owner/name"].',
          inputSchema: z.object({ args: z.array(z.string().max(8000)).min(1).max(40) }),
          execute: (input, toolCtx) => callAviBrain('gh', input, toolCtx),
        }),
        gh_write: defineTool({
          description:
            'Post to GitHub with gh: issue create, issue comment or pr comment, with --title/--body given inline. The user approves it first, and it is refused if it contains a secret. Pushing code is never possible.',
          inputSchema: z.object({ args: z.array(z.string().max(8000)).min(1).max(40) }),
          approval: always(),
          execute: (input, toolCtx) => callAviBrain('gh_write', input, toolCtx),
        }),
        mcp_read: defineTool({
          description: `Call a read-only tool of an MCP server on the Mac. Allowed: ${mcpList}.`,
          inputSchema: z.object({
            server: z.string().min(1).max(80),
            tool: z.string().min(1).max(200),
            args: z.record(z.string(), z.unknown()).optional(),
          }),
          execute: (input, toolCtx) => callAviBrain('mcp_read', input, toolCtx),
        }),
        mcp_call: defineTool({
          description: `Call a tool of an MCP server on the Mac that may change something; the user approves it first. Allowed: ${mcpList}.`,
          inputSchema: z.object({
            server: z.string().min(1).max(80),
            tool: z.string().min(1).max(200),
            args: z.record(z.string(), z.unknown()).optional(),
          }),
          approval: always(),
          execute: (input, toolCtx) => callAviBrain('mcp_call', input, toolCtx),
        }),
        publish_artifact: defineTool({
          description:
            'Save something for the user to look at in an Avi Studio tab: a self-contained page or SVG given as files ({"index.html": "…"}), or built in your sandbox (build: {command, outDir}). It is shown with no network access.',
          inputSchema: z.object({
            title: z.string().min(1).max(120),
            kind: z.enum(['html', 'svg', 'site']),
            files: z.record(z.string(), z.string()).optional(),
            build: z.object({ command: z.string().min(1).max(4000), outDir: z.string().min(1).max(240) }).optional(),
            entry: z.string().min(1).max(240).optional(),
          }),
          execute: (input, toolCtx) => callAviBrain('publish_artifact', input, toolCtx),
        }),
      };
      return Object.fromEntries(Object.entries(tools).filter(([name]) => profile.tools.includes(name)));
    },
  },
});
