/** A tool source: a remote MCP server, one on the Mac (through the companion), a command-line tool, or the companion. */
export interface ConnectorRecord {
  id: string;
  name: string;
  kind: 'mcp_http' | 'mcp_stdio' | 'cli' | 'companion';
  url: string | null;
  authKind: 'none' | 'token' | 'oauth';
  // Where its credential lives in the secrets vault; never the credential itself
  secretRef: string | null;
  // The workspaces that may use it; empty means none until the user picks
  workspaceIds: string[];
  status: 'connected' | 'needs_auth' | 'error' | 'disabled';
  // Per tool: may run freely (read), needs the user's approval, or is off
  toolPolicy: Record<string, 'read' | 'approve' | 'off'>;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** What a tool looked like when the user approved it; a change turns it off until approved again. */
export interface ToolFingerprint {
  // "<connectorId>:<tool>"
  id: string;
  connectorId: string;
  tool: string;
  hash: string;
  approved: boolean;
  seenAt: number;
}
