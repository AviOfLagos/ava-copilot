import type { ConnectorRecord } from '@extension/storage';
import type { ListedTool } from './fingerprint';

/**
 * Tools the browser cannot run itself: MCP servers on the Mac (stdio) and command-line tools. They run through
 * Avi Brain, the Mac companion (WS7), inside its sandbox. This is the interface the connectors call; the
 * companion registers an implementation once it is paired. Until then those connectors say they need it, and
 * nothing here reaches the Mac.
 *
 * Everything else stays the same for them: fingerprints, per-tool policy, the gate and untrusted results.
 */
export interface CompanionToolBridge {
  // Whether the companion runs and is paired with this browser
  available(): Promise<boolean>;
  listTools(connector: ConnectorRecord, options: { signal?: AbortSignal; timeoutMs: number }): Promise<ListedTool[]>;
  // Answers with an MCP CallToolResult (content blocks, optional structuredContent, isError)
  callTool(
    connector: ConnectorRecord,
    tool: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<unknown>;
}

let bridge: CompanionToolBridge | null = null;

/** For the companion stream: makes local MCP servers and command-line tools callable. */
export function registerCompanionToolBridge(next: CompanionToolBridge): void {
  bridge = next;
}

export function companionToolBridge(): CompanionToolBridge | null {
  return bridge;
}

/** Connectors that only the companion can run. */
export function needsCompanion(connector: Pick<ConnectorRecord, 'kind'>): boolean {
  return connector.kind !== 'mcp_http';
}
