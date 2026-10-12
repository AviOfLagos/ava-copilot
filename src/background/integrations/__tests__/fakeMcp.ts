import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

/**
 * A real MCP server (the SDK's), answering through a fetch function instead of a network: the connector code
 * under test talks to it with the real client and Streamable HTTP transport.
 */

export interface FakeTool {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  handler: (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
}

export interface FakeHttpFailure {
  status: number;
  headers?: Record<string, string>;
  // Only for calls to this tool; any request when missing
  tool?: string;
}

export function fakeMcpServer(tools: FakeTool[], options: { token?: string } = {}) {
  const state = {
    // The bearer token the server accepts; none when undefined
    token: options.token,
    tools: new Map(tools.map(tool => [tool.name, tool])),
    calls: [] as { tool: string; args: Record<string, unknown> }[],
    methods: [] as string[],
    failures: [] as FakeHttpFailure[],
    // The next tools request that carries a session gets a 404, as from a server that restarted
    forgetSessions: false,
    authHeaders: [] as (string | null)[],
  };
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  const build = () => {
    const server = new McpServer({ name: 'fake', version: '1.0.0' });
    for (const tool of state.tools.values()) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.schema, annotations: tool.annotations },
        async (args: Record<string, unknown>) => {
          state.calls.push({ tool: tool.name, args });
          return tool.handler(args);
        },
      );
    }
    return server;
  };

  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    state.authHeaders.push(request.headers.get('authorization'));
    let body: { method?: string; params?: { name?: string } } | null = null;
    if (request.method === 'POST') {
      body = await request
        .clone()
        .json()
        .catch(() => null);
      if (body?.method) state.methods.push(body.method);
    }
    if (state.token && request.headers.get('authorization') !== `Bearer ${state.token}`) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'www-authenticate': 'Bearer' },
      });
    }
    const failureIndex = state.failures.findIndex(
      failure => !failure.tool || (body?.method === 'tools/call' && body.params?.name === failure.tool),
    );
    if (failureIndex >= 0) {
      const [failure] = state.failures.splice(failureIndex, 1);
      return new Response(JSON.stringify({ error: `scripted ${failure.status}` }), {
        status: failure.status,
        headers: { 'content-type': 'application/json', ...failure.headers },
      });
    }
    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId) {
      if (state.forgetSessions && body?.method?.startsWith('tools/')) {
        state.forgetSessions = false;
        sessions.clear();
      }
      const transport = sessions.get(sessionId);
      if (!transport) {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }
      return transport.handleRequest(request);
    }
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: id => {
        sessions.set(id, transport);
      },
      onsessionclosed: id => {
        sessions.delete(id);
      },
      enableJsonResponse: true,
    });
    await build().connect(transport);
    return transport.handleRequest(request);
  };

  return { fetch, state, sessions };
}

export const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });
