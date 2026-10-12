/** How a connector's tool may run: freely (it only reads), after the user's click, or not at all. */
export type ToolPolicy = 'read' | 'approve' | 'off';

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
  toolPolicy: Record<string, ToolPolicy>;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  // What kind of failure lastError is (an AppError kind), so the panel can say it in the user's language
  lastErrorKind?: string | null;
  // The well-known server it was added from (see catalog.ts), if any
  catalogId?: string | null;
  // How it is reached: Streamable HTTP (the current MCP transport), or the older HTTP+SSE one. Found on first contact
  transport?: 'auto' | 'streamable_http' | 'sse';
  // How long one call may take before it is given up
  timeoutMs?: number;
  // For token sign-in: the header that carries it ("Authorization" sends "Bearer <token>")
  tokenHeader?: string | null;
  // For OAuth: what is not secret. The tokens and any client secret live in the vault
  oauth?: ConnectorOAuthConfig | null;
  // What the user may see of the credential: its last characters, when it was saved, when it runs out
  credential?: { last4: string | null; savedAt: number; expiresAt: number | null } | null;
  // When the tool list was last read from the server
  toolsCheckedAt?: number | null;
  // What the server said it is when it last answered
  serverInfo?: { name: string; version: string } | null;
}

export interface ConnectorOAuthConfig {
  // A client the user registered with the service (Slack, Google); null when the server registers us itself
  clientId: string | null;
  hasClientSecret: boolean;
  // Scopes to ask for; null lets the server's own metadata decide
  scope: string | null;
  // Parameters a service needs on its sign-in page, e.g. Google's access_type=offline for a refresh token
  authParams?: Record<string, string>;
  // Where the sign-in happens, learned from the server
  authorizationServerUrl?: string | null;
  issuer?: string | null;
}

/** What a tool looked like when the user approved it; a change turns it off until approved again. */
export interface ToolFingerprint {
  // "<connectorId>:<tool>"
  id: string;
  connectorId: string;
  tool: string;
  // Hash of the tool's name, description and input schema as last listed
  hash: string;
  // Whether the user approved the tool as it is now (this hash)
  approved: boolean;
  seenAt: number;
  // The tool as last listed: shown to the user, and to the agent once approved
  title?: string | null;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotationsRecord | null;
  firstSeenAt?: number;
  // The user approved an earlier version of it: a change, not a new tool
  everApproved?: boolean;
  changedAt?: number | null;
  // What it looked like when last approved, to show what changed
  previous?: { description: string; inputSchema: Record<string, unknown> } | null;
  // The server no longer lists it
  missing?: boolean;
}

/** What the server says about a tool. Hints only: a tool runs freely only when the user says it may. */
export interface ToolAnnotationsRecord {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
