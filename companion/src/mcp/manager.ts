import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import type { McpServerState, ToolCallReply, ToolDescriptor } from '@protocol';
import { AppError, fail, toAppError } from '../errors';
import type { Logger } from '../log';

/**
 * Local (stdio) MCP servers, configured on the Mac only, in `<data>/mcp.json`:
 *
 *   { "servers": { "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/notes"],
 *                             "env": {}, "readOnlyTools": ["read_file", "list_directory"] } } }
 *
 * Adding a server means running a program on this Mac, so only a person at the Mac can do it; the
 * extension can list and call tools but never add a server. Each server gets the default safe
 * environment plus its own `env`, never the companion's. Tools carry a fingerprint (name, description,
 * schema): a call that names an older fingerprint is refused, so a server that changes a tool cannot
 * reuse the user's earlier approval.
 */

export const mcpConfigSchema = z.object({
  servers: z
    .record(
      z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
      z.object({
        command: z.string().min(1).max(500),
        args: z.array(z.string().max(2000)).max(50).default([]),
        env: z.record(z.string(), z.string()).default({}),
        cwd: z.string().max(500).optional(),
        // Tools Avi may call without a click; everything else asks first
        readOnlyTools: z.array(z.string().max(200)).max(200).default([]),
        disabled: z.boolean().default(false),
      }),
    )
    .default({}),
});
export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type McpServerConfig = McpConfig['servers'][string];

const CALL_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 20_000;

/** Stable JSON: keys sorted, so the same tool always hashes the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function fingerprintOf(tool: { name: string; description?: string; inputSchema?: unknown }): string {
  return createHash('sha256')
    .update(stable({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? {} }))
    .digest('hex');
}

interface ToolLike {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** What the manager needs of an MCP client; the SDK's Client in use, a fake in tests. */
export interface McpConnection {
  listTools(): Promise<ToolLike[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Omit<ToolCallReply, 'ok'>>;
  close(): Promise<void>;
}

export type McpConnect = (name: string, config: McpServerConfig) => Promise<McpConnection>;

/** Turns what an MCP server returned into the protocol's content, keeping only known block kinds. */
export function toContent(raw: unknown): ToolCallReply['content'] {
  const blocks = (Array.isArray(raw) ? raw : []).filter(
    (block): block is Record<string, unknown> => Boolean(block) && typeof block === 'object' && !Array.isArray(block),
  );
  return blocks.flatMap((block): ToolCallReply['content'] => {
    if (block.type === 'text' && typeof block.text === 'string') return [{ type: 'text' as const, text: block.text }];
    if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      return [{ type: 'image' as const, data: block.data, mimeType: block.mimeType }];
    }
    const resource = block.resource as { uri?: unknown; text?: unknown; mimeType?: unknown } | undefined;
    if (block.type === 'resource' && resource && typeof resource.uri === 'string') {
      return [
        {
          type: 'resource' as const,
          uri: resource.uri,
          text: typeof resource.text === 'string' ? resource.text : undefined,
          mimeType: typeof resource.mimeType === 'string' ? resource.mimeType : undefined,
        },
      ];
    }
    return [];
  });
}

/** The SDK's stdio client for one configured server. */
export const sdkConnect: McpConnect = async (name, config) => {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...getDefaultEnvironment(), ...config.env },
    cwd: config.cwd,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'avi-brain', version: '1' }, { capabilities: {} });
  await client.connect(transport, { timeout: START_TIMEOUT_MS });
  return {
    async listTools() {
      const tools: ToolLike[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CALL_TIMEOUT_MS });
        tools.push(...(page.tools as ToolLike[]));
        cursor = page.nextCursor;
      } while (cursor && tools.length < 1000);
      return tools;
    },
    async callTool(tool, args, signal) {
      const result = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS,
        signal,
      });
      return {
        isError: Boolean(result.isError),
        content: toContent(result.content),
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      };
    },
    close: () => client.close(),
  };
};

interface ServerEntry {
  config: McpServerConfig;
  state: McpServerState;
  connection: McpConnection | null;
  tools: ToolDescriptor[];
}

export class McpManager {
  private readonly servers = new Map<string, ServerEntry>();

  constructor(private readonly deps: { configPath: string; log: Logger; connect?: McpConnect }) {}

  /** Reads mcp.json and starts every enabled server; one failing server does not stop the others. */
  async start(): Promise<void> {
    let config: McpConfig = { servers: {} };
    try {
      config = mcpConfigSchema.parse(JSON.parse(await readFile(this.deps.configPath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.deps.log.warn('mcp.json could not be read', { error: (error as Error).message });
      }
    }
    await Promise.all(Object.entries(config.servers).map(([name, server]) => this.startOne(name, server)));
  }

  private async startOne(name: string, config: McpServerConfig): Promise<void> {
    const entry: ServerEntry = {
      config,
      state: { name, state: config.disabled ? 'off' : 'starting', tools: 0, error: null },
      connection: null,
      tools: [],
    };
    this.servers.set(name, entry);
    if (config.disabled) return;
    try {
      entry.connection = await (this.deps.connect ?? sdkConnect)(name, config);
      entry.tools = (await entry.connection.listTools()).map(tool => ({
        server: name,
        name: tool.name,
        description: (tool.description ?? '').slice(0, 4000),
        inputSchema: tool.inputSchema ?? { type: 'object' },
        ...(tool.annotations ? { annotations: pickAnnotations(tool.annotations) } : {}),
        fingerprint: fingerprintOf(tool),
      }));
      entry.state = { name, state: 'ready', tools: entry.tools.length, error: null };
      this.deps.log.info('mcp server ready', { server: name, tools: entry.tools.length });
    } catch (error) {
      entry.state = { name, state: 'error', tools: 0, error: toAppError(error).message.slice(0, 300) };
      this.deps.log.warn('mcp server failed to start', { server: name });
    }
  }

  states(): McpServerState[] {
    return [...this.servers.values()].map(entry => entry.state);
  }

  tools(): ToolDescriptor[] {
    return [...this.servers.values()].flatMap(entry => entry.tools);
  }

  /**
   * Whether a tool may run without a click: only when the user listed it as read-only in mcp.json. A
   * server's own readOnlyHint is its word about itself, so it is shown but never trusted.
   */
  isReadOnly(server: string, tool: string): boolean {
    const entry = this.servers.get(server);
    return Boolean(entry?.config.readOnlyTools.includes(tool));
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    options: { fingerprint?: string; signal?: AbortSignal } = {},
  ): Promise<ToolCallReply> {
    const entry = this.servers.get(server);
    if (!entry) fail('not_found', `There is no MCP server "${server}" on this Mac.`);
    if (!entry.connection || entry.state.state !== 'ready') {
      fail(
        'unavailable',
        `The MCP server "${server}" is not running${entry.state.error ? `: ${entry.state.error}` : '.'}`,
      );
    }
    const descriptor = entry.tools.find(item => item.name === tool);
    if (!descriptor) fail('not_found', `"${server}" has no tool "${tool}".`);
    if (options.fingerprint && options.fingerprint !== descriptor.fingerprint) {
      fail('forbidden', `"${tool}" changed since you approved it. Review it again in Connectors.`);
    }
    try {
      return { ok: true, ...(await entry.connection.callTool(tool, args, options.signal)) };
    } catch (error) {
      const appError = toAppError(error);
      // A call cut off may have done its work: never retried by itself
      if (appError.kind === 'timeout' || appError.kind === 'network') {
        throw new AppError('unknown_outcome', `"${tool}" did not answer in time; it may or may not have run.`);
      }
      throw appError;
    }
  }

  async stop(): Promise<void> {
    await Promise.all([...this.servers.values()].map(entry => entry.connection?.close().catch(() => {})));
    this.servers.clear();
  }
}

function pickAnnotations(raw: Record<string, unknown>): ToolDescriptor['annotations'] {
  const out: NonNullable<ToolDescriptor['annotations']> = {};
  if (typeof raw.title === 'string') out.title = raw.title.slice(0, 200);
  for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  return out;
}
