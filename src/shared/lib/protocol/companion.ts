import { z } from 'zod';

/**
 * The one protocol between the extension and Nex Brain, the companion on the Mac. Both sides import this
 * file: the extension's background (bridge client), the companion's server, and the E2E mock companion,
 * so a message either side sends is checked against the same schema on the other.
 *
 * Plain zod and erasable TypeScript only (no enums, no imports but zod): Node runs this file as it is, and
 * the companion and the extension each bundle it.
 *
 * Transport: HTTP on 127.0.0.1. Every /v1 request except pairing carries `Authorization: Bearer <token>`,
 * and the browser adds `Origin: chrome-extension://<the pinned id>`; the companion refuses anything else.
 * Every /v1 call is a POST, PUT or DELETE: the browser sends Origin on those, but not on an extension's
 * GET to a host it has permission for (seen in Brave), so the API has no GET at all.
 * Avi Studio pages (/studio, /view) are opened in a tab: a one-time token in the URL fragment becomes a
 * short-lived view key, never the API token.
 */

export const COMPANION_PROTOCOL_VERSION = 1;
export const COMPANION_HOST = '127.0.0.1';
export const COMPANION_DEFAULT_PORT = 47615;
// The extension's pinned ID (manifest `key`); the companion only answers this origin
export const COMPANION_EXTENSION_ID = 'fckijnclcihjnokahdnbogpbeiimfdio';
export const COMPANION_EXTENSION_ORIGIN = `chrome-extension://${COMPANION_EXTENSION_ID}`;

// All POST, except PUT/DELETE /v1/workflows/:id; sessions take /:id/messages, /answer, /cancel, /events
export const COMPANION_ROUTES = {
  pair: '/v1/pair',
  unpair: '/v1/unpair',
  health: '/v1/health',
  sandboxRun: '/v1/sandbox/run',
  gh: '/v1/gh',
  tools: '/v1/tools/list',
  toolCall: '/v1/tools/call',
  sessions: '/v1/sessions',
  workflows: '/v1/workflows',
  workflowSync: '/v1/workflows/sync',
  workflowAck: '/v1/workflows/sync/ack',
  artifacts: '/v1/artifacts',
  artifactList: '/v1/artifacts/list',
  studio: '/studio',
  view: '/view',
} as const;

// Bodies of the calls that only read
export const healthRequestSchema = z.object({ fresh: z.boolean().default(false) });
export const cursorRequestSchema = z.object({ cursor: z.number().int().nonnegative().default(0) });

// ── Shared pieces ─────────────────────────────────────────────────────────────────────────────────

// The kinds of AppError (src/shared/lib/errors): the extension turns a reply's error straight into one
export const COMPANION_ERROR_KINDS = [
  'network',
  'timeout',
  'rate_limit',
  'quota',
  'auth',
  'forbidden',
  'invalid',
  'not_found',
  'unavailable',
  'cancelled',
  'budget',
  'unknown_outcome',
  'unknown',
] as const;
export type CompanionErrorKind = (typeof COMPANION_ERROR_KINDS)[number];

/** The HTTP status that carries each kind of error. */
export const STATUS_OF_KIND: Record<CompanionErrorKind, number> = {
  network: 502,
  timeout: 504,
  rate_limit: 429,
  quota: 402,
  auth: 401,
  forbidden: 403,
  invalid: 400,
  not_found: 404,
  unavailable: 503,
  cancelled: 409,
  budget: 402,
  unknown_outcome: 500,
  unknown: 500,
};

export const errorReplySchema = z.object({
  ok: z.literal(false),
  error: z.object({
    kind: z.enum(COMPANION_ERROR_KINDS),
    // A plain sentence for the user; never a secret, a path outside the sandbox or a stack
    message: z.string().max(1000),
    retryAfterMs: z.number().int().nonnegative().optional(),
  }),
});
export type ErrorReply = z.infer<typeof errorReplySchema>;

// Every request that does something carries one; the companion answers a repeat with the first answer
export const requestIdSchema = z.string().min(8).max(100);
// Agent profiles, workflows and artifacts are named on disk and in Docker by these
export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Lowercase letters, digits, "-" and "_".');
// A file path inside an artifact or a sandbox workspace: relative, no "..", no backslashes
export const relativePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(isSafeRelativePath, 'A relative path inside the workspace, without "..".');

export function isSafeRelativePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

// ── Pairing ───────────────────────────────────────────────────────────────────────────────────────

// Eight characters from an alphabet without look-alikes, shown as XXXX-XXXX
export const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A code as typed (spaces, lower case, no dash) in its canonical XXXX-XXXX form, or null. */
export function normalizePairingCode(input: string): string | null {
  const letters = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (letters.length !== 8 || [...letters].some(char => !PAIRING_ALPHABET.includes(char))) return null;
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

export const pairRequestSchema = z.object({
  code: z.string().min(8).max(20),
  // Shown in the companion's log: which browser paired
  client: z.string().trim().min(1).max(80),
});
export type PairRequest = z.infer<typeof pairRequestSchema>;

export const pairReplySchema = z.object({
  ok: z.literal(true),
  token: z.string().min(32).max(200),
  companionId: z.string().min(1).max(100),
  version: z.string().max(40),
  protocol: z.number().int(),
});
export type PairReply = z.infer<typeof pairReplySchema>;

export const okReplySchema = z.object({ ok: z.literal(true) });

// ── Health ────────────────────────────────────────────────────────────────────────────────────────

export const dockerStateSchema = z.object({
  state: z.enum(['up', 'down', 'missing']),
  // What to do about it, e.g. "Docker is not running. Start Docker Desktop, then try again."
  message: z.string().max(400),
  version: z.string().max(40).nullable(),
  imageReady: z.boolean(),
});
export type DockerState = z.infer<typeof dockerStateSchema>;

export const engineStateSchema = z.object({
  kind: z.enum(['eve', 'none']),
  state: z.enum(['ready', 'starting', 'down', 'off']),
  message: z.string().max(400).nullable(),
});

export const mcpServerStateSchema = z.object({
  name: z.string().max(80),
  state: z.enum(['ready', 'starting', 'error', 'off']),
  tools: z.number().int().nonnegative(),
  error: z.string().max(400).nullable(),
});
export type McpServerState = z.infer<typeof mcpServerStateSchema>;

export const healthReplySchema = z.object({
  ok: z.literal(true),
  protocol: z.number().int(),
  version: z.string().max(40),
  companionId: z.string().max(100),
  uptimeMs: z.number().nonnegative(),
  docker: dockerStateSchema,
  engine: engineStateSchema,
  mcp: z.array(mcpServerStateSchema),
  workflows: z.object({ active: z.number().int().nonnegative(), running: z.number().int().nonnegative() }),
});
export type HealthReply = z.infer<typeof healthReplySchema>;

// ── Sandbox (Docker, one per agent profile) ───────────────────────────────────────────────────────

export const sandboxPolicySchema = z.object({
  // No network unless the profile needs it (package installs); 'open' is unrestricted egress
  network: z.enum(['none', 'open']).default('none'),
  cpus: z.number().min(0.25).max(8).default(1),
  memoryMb: z.number().int().min(128).max(16_384).default(1024),
  timeoutSec: z.number().int().min(1).max(3600).default(300),
});
export type SandboxPolicy = z.infer<typeof sandboxPolicySchema>;
export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = sandboxPolicySchema.parse({});

/** The sandbox a routine's commands run in: its agent's, or one shared by routines that have no agent. */
export function sandboxProfileFor(agentId: string | null | undefined): string {
  const id = (agentId ?? '').toLowerCase();
  return idSchema.safeParse(id).success ? id : 'routines';
}

export const sandboxRunRequestSchema = z.object({
  requestId: requestIdSchema,
  profileId: idSchema,
  // One shell command line, run with `sh -lc` inside the container, in /workspace
  command: z.string().trim().min(1).max(8000),
  policy: sandboxPolicySchema.partial().optional(),
  stdin: z.string().max(1_000_000).optional(),
});
export type SandboxRunRequest = z.infer<typeof sandboxRunRequestSchema>;

export const sandboxRunReplySchema = z.object({
  ok: z.literal(true),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
  // Output past the cap was dropped
  truncated: z.boolean(),
  durationMs: z.number().nonnegative(),
});
export type SandboxRunReply = z.infer<typeof sandboxRunReplySchema>;

// ── gh on the host (allowlisted subcommands) ──────────────────────────────────────────────────────

export const ghRequestSchema = z.object({
  requestId: requestIdSchema,
  args: z.array(z.string().max(8000)).min(1).max(40),
  // A write (issue create, comments) runs only when the user's click is attached; reads ignore it
  approved: z.boolean().default(false),
});
export type GhRequest = z.infer<typeof ghRequestSchema>;

export const ghReplySchema = z.object({
  ok: z.literal(true),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});
export type GhReply = z.infer<typeof ghReplySchema>;

// ── Tools from the companion's stdio MCP servers (a connector for the extension) ─────────────────

export const toolAnnotationsSchema = z
  .object({
    title: z.string().max(200),
    readOnlyHint: z.boolean(),
    destructiveHint: z.boolean(),
    idempotentHint: z.boolean(),
    openWorldHint: z.boolean(),
  })
  .partial();

export const toolDescriptorSchema = z.object({
  server: z.string().max(80),
  name: z.string().max(200),
  description: z.string().max(4000),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: toolAnnotationsSchema.optional(),
  // sha256 of name + description + input schema: a changed tool is off until the user approves it again
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>;

export const toolListReplySchema = z.object({
  ok: z.literal(true),
  servers: z.array(mcpServerStateSchema),
  tools: z.array(toolDescriptorSchema),
});
export type ToolListReply = z.infer<typeof toolListReplySchema>;

export const toolCallRequestSchema = z.object({
  requestId: requestIdSchema,
  server: z.string().min(1).max(80),
  tool: z.string().min(1).max(200),
  args: z.record(z.string(), z.unknown()).default({}),
  // The fingerprint the user approved; a tool that changed since is refused
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type ToolCallRequest = z.infer<typeof toolCallRequestSchema>;

export const toolContentSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
  z.object({
    type: z.literal('resource'),
    uri: z.string(),
    text: z.string().optional(),
    mimeType: z.string().optional(),
  }),
]);

export const toolCallReplySchema = z.object({
  ok: z.literal(true),
  isError: z.boolean(),
  // Untrusted: whatever the server returned. The extension wraps it before any model sees it
  content: z.array(toolContentSchema),
  structuredContent: z.unknown().optional(),
});
export type ToolCallReply = z.infer<typeof toolCallReplySchema>;

/**
 * What WS4's connectors see of the companion: one tool source among the MCP servers. The extension's
 * `src/background/companion/connector.ts` implements it over this protocol.
 */
export interface CompanionToolSource {
  readonly kind: 'companion';
  listTools(signal?: AbortSignal): Promise<ToolDescriptor[]>;
  callTool(
    call: { server: string; tool: string; args: Record<string, unknown>; fingerprint?: string },
    signal?: AbortSignal,
  ): Promise<Omit<ToolCallReply, 'ok'>>;
}

// ── Agent sessions (run by eve on the Mac) ────────────────────────────────────────────────────────

// Tools an agent profile may give its sessions; the companion enforces each one's policy
export const COMPANION_TOOL_NAMES = [
  'run_command',
  'read_file',
  'write_file',
  'gh',
  'gh_write',
  'mcp_read',
  'mcp_call',
  'publish_artifact',
] as const;
export type CompanionToolName = (typeof COMPANION_TOOL_NAMES)[number];

export const modelConfigSchema = z.object({
  // A label for logs and usage: ollama, lmstudio, openrouter, nvidia, openai, custom…
  provider: z.string().trim().min(1).max(40),
  // Any OpenAI-compatible endpoint, e.g. http://127.0.0.1:11434/v1
  baseUrl: z.url().max(500),
  model: z.string().trim().min(1).max(200),
  // Kept in the companion's memory only, never written to disk or into a session
  apiKey: z.string().max(500).optional(),
  contextWindow: z.number().int().min(1024).max(4_000_000).default(32_768),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;

export const agentProfileSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(80),
  instructions: z.string().max(20_000).default(''),
  tools: z.array(z.enum(COMPANION_TOOL_NAMES)).max(COMPANION_TOOL_NAMES.length).default([]),
  // MCP tools this profile may use, as "server/tool"
  mcpTools: z.array(z.string().max(300)).max(100).default([]),
  sandbox: sandboxPolicySchema.default(DEFAULT_SANDBOX_POLICY),
});
export type AgentProfile = z.infer<typeof agentProfileSchema>;

export const sessionCreateRequestSchema = z.object({
  requestId: requestIdSchema,
  profile: agentProfileSchema,
  model: modelConfigSchema,
  message: z.string().trim().min(1).max(100_000),
});
export type SessionCreateRequest = z.infer<typeof sessionCreateRequestSchema>;

export const sessionCreateReplySchema = z.object({ ok: z.literal(true), sessionId: z.string().min(1).max(200) });

export const sessionMessageRequestSchema = z.object({
  requestId: requestIdSchema,
  message: z.string().trim().min(1).max(100_000),
});

export const sessionAnswerRequestSchema = z.object({
  requestId: requestIdSchema,
  approvalId: z.string().min(1).max(200),
  approved: z.boolean(),
  // Why it was declined, passed to the model as the user's words
  note: z.string().max(2000).optional(),
});
export type SessionAnswerRequest = z.infer<typeof sessionAnswerRequestSchema>;

const turnId = z.string().max(100);
// The position in the session's durable stream: reconnect with cursor = index + 1
const index = z.number().int().nonnegative();

export const pendingApprovalSchema = z.object({
  approvalId: z.string().max(200),
  callId: z.string().max(200),
  tool: z.string().max(200),
  input: z.unknown(),
  prompt: z.string().max(1000),
});
export type PendingApproval = z.infer<typeof pendingApprovalSchema>;

export const sessionEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.started'), index }),
  z.object({ type: z.literal('turn.started'), index, turnId }),
  z.object({ type: z.literal('message.delta'), index, turnId, text: z.string() }),
  // The model's finished words for a step; `final` when it is the turn's answer (not a pause for tools)
  z.object({ type: z.literal('message'), index, turnId, text: z.string(), final: z.boolean() }),
  z.object({
    type: z.literal('tool.called'),
    index,
    turnId,
    calls: z.array(z.object({ callId: z.string(), tool: z.string(), input: z.unknown() })),
  }),
  z.object({
    type: z.literal('tool.result'),
    index,
    turnId,
    callId: z.string(),
    tool: z.string(),
    // Untrusted
    output: z.unknown(),
    status: z.string().max(40),
  }),
  z.object({ type: z.literal('approval.requested'), index, turnId, approvals: z.array(pendingApprovalSchema) }),
  z.object({
    type: z.literal('approval.resolved'),
    index,
    turnId,
    resolutions: z.array(z.object({ approvalId: z.string(), outcome: z.string().max(40) })),
  }),
  z.object({ type: z.literal('turn.waiting'), index, turnId, on: z.string().max(40) }),
  z.object({
    type: z.literal('turn.completed'),
    index,
    turnId,
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
  }),
  z.object({ type: z.literal('turn.failed'), index, turnId, message: z.string().max(2000) }),
  z.object({ type: z.literal('turn.cancelled'), index, turnId }),
  // Waiting for the next message
  z.object({ type: z.literal('session.idle'), index }),
  z.object({ type: z.literal('session.ended'), index, reason: z.string().max(200) }),
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;

// ── Routines that run on the Mac (Brave may be closed) ────────────────────────────────────────────

/** The kinds of step the Mac can run: no browser, no knowledge base, no connectors through the extension. */
export const MAC_NODE_TYPES = [
  'trigger.schedule',
  'trigger.manual',
  'step.http_get',
  'step.llm',
  'step.condition',
  'step.sandbox',
  'out.inbox',
  'out.brief_section',
  'out.notify',
] as const;

export const workflowPutRequestSchema = z.object({
  requestId: requestIdSchema,
  workflow: z.object({
    id: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(80),
    version: z.number().int().nonnegative(),
    workspaceId: z.string().max(100).nullable(),
    agentId: z.string().max(100).nullable(),
    status: z.enum(['active', 'paused']),
    // A WorkflowSpec; the companion checks it with the same engine and refuses kinds it cannot run
    spec: z.unknown(),
  }),
  // For step.llm; its key is kept in memory, or in the macOS Keychain when keepKey is set
  model: modelConfigSchema.optional(),
  keepKey: z.boolean().default(false),
  sandbox: sandboxPolicySchema.partial().optional(),
});
export type WorkflowPutRequest = z.infer<typeof workflowPutRequestSchema>;

export const workflowRunRequestSchema = z.object({ requestId: requestIdSchema });
export const workflowRunReplySchema = z.object({ ok: z.literal(true), runId: z.string() });

export const workflowAnswerRequestSchema = z.object({
  requestId: requestIdSchema,
  runId: z.string().min(1).max(100),
  nodeId: z.string().min(1).max(40),
  approved: z.boolean(),
});

export const outboxItemSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string(),
    kind: z.literal('inbox'),
    workflowId: z.string(),
    runId: z.string(),
    nodeId: z.string(),
    title: z.string(),
    body: z.string(),
    priority: z.enum(['low', 'normal', 'high']),
    at: z.number(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal('brief_section'),
    workflowId: z.string(),
    runId: z.string(),
    nodeId: z.string(),
    title: z.string(),
    markdown: z.string(),
    at: z.number(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal('notify'),
    workflowId: z.string(),
    runId: z.string(),
    nodeId: z.string(),
    title: z.string(),
    message: z.string(),
    at: z.number(),
  }),
  // A step that acts for the user waits for their click: the extension shows it in the Inbox
  z.object({
    id: z.string(),
    kind: z.literal('approval'),
    workflowId: z.string(),
    runId: z.string(),
    nodeId: z.string(),
    label: z.string(),
    detail: z.string(),
    at: z.number(),
  }),
]);
export type OutboxItem = z.infer<typeof outboxItemSchema>;

export const workflowSyncReplySchema = z.object({
  ok: z.literal(true),
  // Pass back as ?cursor= to get only what changed since
  cursor: z.number().int().nonnegative(),
  // RunRecord and RunStep as the workflow engine writes them (src/storage/lib/workflows/types.ts)
  runs: z.array(
    z.object({ run: z.record(z.string(), z.unknown()), steps: z.array(z.record(z.string(), z.unknown())) }),
  ),
  outbox: z.array(outboxItemSchema),
});
export type WorkflowSyncReply = z.infer<typeof workflowSyncReplySchema>;

export const workflowAckRequestSchema = z.object({
  requestId: requestIdSchema,
  outboxIds: z.array(z.string().max(100)).max(500),
});

// ── Artifacts and Avi Studio ──────────────────────────────────────────────────────────────────────

export const artifactCreateRequestSchema = z
  .object({
    requestId: requestIdSchema,
    profileId: idSchema,
    title: z.string().trim().min(1).max(120),
    kind: z.enum(['html', 'svg', 'site']),
    // Small artifacts come inline…
    files: z.record(relativePathSchema, z.string().max(2_000_000)).optional(),
    // …built ones are made in the profile's sandbox and copied out of outDir
    build: z.object({ command: z.string().trim().min(1).max(4000), outDir: relativePathSchema }).optional(),
    entry: relativePathSchema.default('index.html'),
  })
  .refine(value => Boolean(value.files) !== Boolean(value.build), 'Give either files or a build, not both.');
export type ArtifactCreateRequest = z.infer<typeof artifactCreateRequestSchema>;

export const artifactSchema = z.object({
  id: z.string().max(100),
  title: z.string().max(120),
  kind: z.enum(['html', 'svg', 'site']),
  entry: z.string().max(240),
  profileId: z.string().max(64),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  createdAt: z.number(),
});
export type Artifact = z.infer<typeof artifactSchema>;

export const artifactListReplySchema = z.object({ ok: z.literal(true), artifacts: z.array(artifactSchema) });
export const artifactCreateReplySchema = z.object({ ok: z.literal(true), artifact: artifactSchema });
// The Avi Studio address, with a one-time token in its fragment
export const artifactOpenReplySchema = z.object({ ok: z.literal(true), url: z.string().max(500) });

export const studioSessionRequestSchema = z.object({ token: z.string().min(32).max(200) });
export const studioSessionReplySchema = z.object({ ok: z.literal(true), viewKey: z.string().min(32).max(200) });

export const STUDIO_TOKEN_TTL_MS = 2 * 60_000;
export const VIEW_KEY_TTL_MS = 8 * 60 * 60_000;
export const ARTIFACT_LIMITS = { maxFiles: 300, maxBytes: 25_000_000 } as const;

/**
 * How an artifact is served: an opaque origin with scripts but no way to reach the network or the
 * companion. Images, fonts and media only from the artifact itself or data:/blob: URLs.
 */
export const ARTIFACT_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

export const ARTIFACT_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': ARTIFACT_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

// The Studio page's own script: turns the fragment's one-time token into a view key and shows the artifact
export const STUDIO_SCRIPT = `(async () => {
  const token = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  const status = document.getElementById('status');
  const id = document.body.dataset.artifact;
  if (!token) { status.textContent = 'This link was already used. Open the artifact again from Nex Copilot.'; return; }
  try {
    const response = await fetch('/studio/' + encodeURIComponent(id) + '/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    });
    const reply = await response.json();
    if (!response.ok || !reply.ok) throw new Error(reply.error && reply.error.message || 'Refused');
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', document.title);
    frame.src = '/view/' + encodeURIComponent(id) + '/' + reply.viewKey + '/' + document.body.dataset.entry;
    document.getElementById('stage').replaceChildren(frame);
    status.textContent = '';
  } catch (error) {
    status.textContent = 'This link has expired. Open the artifact again from Nex Copilot.';
  }
})();`;

export const STUDIO_STYLE = `html,body{margin:0;height:100%;background:#0e0f11;color:#e6e6e6;font:13px/1.4 system-ui,sans-serif}
header{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid #26282c}
header b{font-weight:600}header span{color:#8b8f97}#status{padding:16px 12px;color:#c9a227}
#stage{position:absolute;top:37px;left:0;right:0;bottom:0}iframe{border:0;width:100%;height:100%;background:#fff}`;

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}

/** The Avi Studio page for one artifact. Its CSP allows only its own script and style (by hash). */
export function studioPageHtml(artifact: { id: string; title: string; entry: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(artifact.title)} — Avi Studio</title><style>${STUDIO_STYLE}</style></head>
<body data-artifact="${escapeHtml(artifact.id)}" data-entry="${escapeHtml(artifact.entry)}">
<header><b>Avi Studio</b><span>${escapeHtml(artifact.title)}</span></header>
<div id="status" role="status">Opening…</div><div id="stage"></div>
<script>${STUDIO_SCRIPT}</script></body></html>`;
}

/** The Studio page's CSP, given the base64 sha256 of STUDIO_SCRIPT and STUDIO_STYLE (each side hashes them itself). */
export function studioCsp(scriptHash: string, styleHash: string): string {
  return [
    "default-src 'none'",
    `script-src 'sha256-${scriptHash}'`,
    `style-src 'sha256-${styleHash}'`,
    "connect-src 'self'",
    "frame-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// ── Replies, in general ───────────────────────────────────────────────────────────────────────────

/** Whether a parsed body is the companion's error reply. */
export function isErrorReply(value: unknown): value is ErrorReply {
  return errorReplySchema.safeParse(value).success;
}
