import type { CompanionToolSource } from '@src/shared/lib/protocol/companion';
import { companionClient } from './client';
import type { CompanionClient } from './client';

/**
 * Avi Brain's stdio MCP servers as one tool source for the Connectors stream (WS4): list the tools (with
 * the fingerprint each approval must name) and call one. Results are untrusted content; the caller wraps
 * them before any model sees them, and decides which calls need the user's click.
 */
export function companionToolSource(client: CompanionClient = companionClient): CompanionToolSource {
  return {
    kind: 'companion',
    async listTools(signal) {
      return (await client.listTools(signal)).tools;
    },
    async callTool(call, signal) {
      const reply = await client.callTool({ requestId: crypto.randomUUID(), ...call }, signal);
      return { isError: reply.isError, content: reply.content, structuredContent: reply.structuredContent };
    },
  };
}
