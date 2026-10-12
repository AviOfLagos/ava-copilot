// A tiny stdio MCP server for tests: one read tool and one that "writes".
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo', version: '1.0.0' });
server.registerTool(
  'echo',
  { description: 'Echo a text back.', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
);
server.registerTool(
  'save_note',
  { description: 'Pretend to save a note.', inputSchema: { note: z.string() } },
  async ({ note }) => ({ content: [{ type: 'text', text: `saved ${note.length} characters` }] }),
);
// The environment it was given, to check that nothing of the companion's leaks in
server.registerTool('env', { description: 'List environment variable names.', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: Object.keys(process.env).sort().join(',') }],
}));
await server.connect(new StdioServerTransport());
