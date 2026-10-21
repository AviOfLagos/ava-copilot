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
  // Ava in a Google Meet call, as her own participant: MEET_ROUTES below
  meet: '/v1/meet',
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

// ── Ava in a Google Meet call ─────────────────────────────────────────────────────────────────────
//
// Nex Brain runs a browser of its own, signed in by the user (by hand) to a dedicated account, that joins a
// call as a separate participant. Its microphone carries the companion's audio and nothing else: the
// extension renders the approved words to speech and sends the clip; the companion plays it into that
// browser's microphone. Nothing is ever injected into the user's own Meet tab.

export const MEET_ROUTES = {
  status: '/v1/meet/status',
  signin: '/v1/meet/signin',
  join: '/v1/meet/join',
  say: '/v1/meet/say',
  stop: '/v1/meet/stop',
  leave: '/v1/meet/leave',
} as const;

export const MEET_STATES = [
  // No call
  'idle',
  // The sign-in window is open for the user
  'signing_in',
  'joining',
  // Asked to join; the host has not let her in yet
  'waiting_admission',
  'in_call',
  'left',
  'failed',
] as const;
export type MeetState = (typeof MEET_STATES)[number];

const MEET_CODE = /^[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}$/;
// The only addresses the companion opens: a call, by its code (three letters, four, three; a few older codes
// have four in the first or last group)
export const MEET_URL_PATTERN = /^https:\/\/meet\.google\.com\/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}$/;

/**
 * A Google Meet call's address in the one form the companion will open, or null for anything else. A bare
 * code ("abc-defg-hij"), "meet.google.com/abc-defg-hij", and a link with a query (?authuser=0) or fragment
 * become https://meet.google.com/abc-defg-hij. Another host or scheme, a deeper path, a user name or a port
 * is refused, never repaired.
 */
export function normalizeMeetUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let text = input.trim().toLowerCase();
  if (!text || text.length > 300) return null;
  if (MEET_CODE.test(text)) text = `https://meet.google.com/${text}`;
  else if (text.startsWith('meet.google.com/')) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'meet.google.com' || url.port || url.username || url.password) {
    return null;
  }
  const candidate = `https://meet.google.com${url.pathname.replace(/\/$/, '')}`;
  return MEET_URL_PATTERN.test(candidate) ? candidate : null;
}

/** The call code of a valid Meet address ("abc-defg-hij"), or null. */
export function meetCodeOf(input: unknown): string | null {
  const url = normalizeMeetUrl(input);
  return url ? url.slice('https://meet.google.com/'.length) : null;
}

// A spoken clip: WAV as base64. 7 MB of base64 is over two minutes of 24 kHz speech
export const MEET_AUDIO_MAX_CHARS = 7_000_000;
export const MEET_SAY_MAX_BODY_BYTES = MEET_AUDIO_MAX_CHARS + 2000;

export const meetStatusSchema = z.object({
  state: z.enum(MEET_STATES),
  // Why it failed or left, as a plain sentence
  reason: z.string().max(400).nullable(),
  // The call she is in or joining
  meetingCode: z.string().max(20).nullable(),
  speaking: z.boolean(),
  // Whether her browser looked signed in when it was last checked (null: not checked yet)
  signedIn: z.boolean().nullable(),
  // Whether a Chrome, Brave or Chromium to run her in was found on the Mac
  browserFound: z.boolean(),
  since: z.number(),
});
export type MeetStatus = z.infer<typeof meetStatusSchema>;

export const meetStatusReplySchema = z.object({ ok: z.literal(true), status: meetStatusSchema });

export const meetJoinRequestSchema = z.object({ requestId: requestIdSchema, url: z.string().max(300) });
export type MeetJoinRequest = z.infer<typeof meetJoinRequestSchema>;

export const meetSayRequestSchema = z.object({
  requestId: requestIdSchema,
  // The call the words were approved for: refused when she is in another one
  meetingCode: z.string().regex(MEET_CODE),
  mimeType: z.literal('audio/wav'),
  audio: z
    .string()
    .min(64)
    .max(MEET_AUDIO_MAX_CHARS)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Base64 only.'),
});
export type MeetSayRequest = z.infer<typeof meetSayRequestSchema>;

export const meetSayReplySchema = z.object({
  ok: z.literal(true),
  durationMs: z.number().nonnegative(),
  status: meetStatusSchema,
});

// ── Ava on WhatsApp ───────────────────────────────────────────────────────────────────────────────
//
// Nex Brain keeps a WhatsApp Web session of its own (an unofficial client the user chose, linked by
// scanning a code under Linked devices). It talks to one person only, the owner: the linked account's own
// "Message yourself" chat, and optionally one other number of the user's. Every other chat is dropped
// before anything is kept, and a send to any other chat is refused. The owner's text messages wait in a
// queue the extension pulls; the extension answers through `send`, which always goes to the owner.

export const WHATSAPP_ROUTES = {
  status: '/v1/whatsapp/status',
  link: '/v1/whatsapp/link',
  unlink: '/v1/whatsapp/unlink',
  owner: '/v1/whatsapp/owner',
  inbox: '/v1/whatsapp/inbox',
  ack: '/v1/whatsapp/ack',
  send: '/v1/whatsapp/send',
  quiet: '/v1/whatsapp/quiet',
} as const;

export const WHATSAPP_STATES = [
  // No session: nothing runs
  'not_linked',
  // Its browser is starting, or restoring a saved session
  'starting',
  // A code waits to be scanned (qr holds it)
  'scan',
  'linked',
  // Was linked, and the connection dropped (the phone offline, the session ended elsewhere)
  'disconnected',
  // Could not start or link (message says why)
  'failed',
] as const;
export type WhatsAppState = (typeof WHATSAPP_STATES)[number];

// Digits only, with the country code: 2348012345678
export const WHATSAPP_NUMBER = /^[1-9][0-9]{7,14}$/;
export const WHATSAPP_TEXT_MAX = 4000;
export const WHATSAPP_NOTICE_KINDS = ['reply', 'approval', 'meeting', 'brief', 'routine'] as const;
export type WhatsAppNoticeKind = (typeof WHATSAPP_NOTICE_KINDS)[number];

export const whatsappStatusSchema = z.object({
  state: z.enum(WHATSAPP_STATES),
  // The code to show while state is 'scan' (the pairing string, or a picture of it as a data URL); never
  // stored or logged
  qr: z.string().max(200_000).nullable(),
  // The linked account's number, digits only
  number: z.string().nullable(),
  // The user's other number, when Ava has a number of her own
  ownerNumber: z.string().nullable(),
  message: z.string().nullable(),
  queued: z.number().int().nonnegative(),
  sentLastHour: z.number().int().nonnegative(),
  sendLimitPerHour: z.number().int().positive(),
});
export type WhatsAppStatus = z.infer<typeof whatsappStatusSchema>;

export const whatsappStatusReplySchema = z.object({ ok: z.literal(true), status: whatsappStatusSchema });

export const whatsappOwnerRequestSchema = z.object({
  number: z.string().regex(WHATSAPP_NUMBER).nullable(),
});
export type WhatsAppOwnerRequest = z.infer<typeof whatsappOwnerRequestSchema>;

// Quiet hours, kept by Nex Brain too: only answers and approvals go out in them
export const WHATSAPP_TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;
export const whatsappQuietRequestSchema = z.object({
  quietStart: z.string().regex(WHATSAPP_TIME),
  quietEnd: z.string().regex(WHATSAPP_TIME),
});
export type WhatsAppQuietRequest = z.infer<typeof whatsappQuietRequestSchema>;

export const whatsappMessageSchema = z.object({
  id: z.string().min(1).max(200),
  text: z.string().max(WHATSAPP_TEXT_MAX),
  at: z.number(),
});
export type WhatsAppMessage = z.infer<typeof whatsappMessageSchema>;

export const whatsappInboxReplySchema = z.object({
  ok: z.literal(true),
  messages: z.array(whatsappMessageSchema).max(50),
  status: whatsappStatusSchema,
});

export const whatsappAckRequestSchema = z.object({ ids: z.array(z.string().min(1).max(200)).max(100) });

export const whatsappSendRequestSchema = z.object({
  requestId: requestIdSchema,
  text: z.string().min(1).max(WHATSAPP_TEXT_MAX),
  kind: z.enum(WHATSAPP_NOTICE_KINDS),
  // The owner's message this answers: the reply goes to the chat it came from
  replyTo: z.string().min(1).max(200).optional(),
});
export type WhatsAppSendRequest = z.infer<typeof whatsappSendRequestSchema>;

export const whatsappSendReplySchema = z.object({ ok: z.literal(true), status: whatsappStatusSchema });

// ── Backups: memory and settings that outlive an uninstall ────────────────────────────────────────
// The extension sends a gzipped snapshot of its database and settings in chunks (it can be hundreds of MB);
// Nex Brain keeps the files under its data dir, which uninstalling the extension does not touch. API keys and
// sign-ins travel separately and are kept encrypted under a key in the macOS Keychain, never in a snapshot.

export const BACKUP_ROUTES = {
  list: '/v1/backups/list',
  begin: '/v1/backups/uploads',
  // PUT
  chunk: '/v1/backups/uploads/:uploadId/chunks/:index',
  commit: '/v1/backups/uploads/:uploadId/commit',
  // One chunk of a stored snapshot
  read: '/v1/backups/:id/read',
  // DELETE
  remove: '/v1/backups/:id',
  secretsPut: '/v1/backups/secrets/put',
  secretsGet: '/v1/backups/secrets/get',
  // DELETE
  secretsClear: '/v1/backups/secrets',
} as const;

/** A route with its parameters filled in, e.g. backupPath(BACKUP_ROUTES.read, { id }). */
export function backupPath(route: string, params: Record<string, string | number>): string {
  return route.replace(/:([A-Za-z]+)/g, (_, key: string) => encodeURIComponent(String(params[key])));
}

// One chunk of a snapshot before base64; its request body is that base64 in JSON
export const BACKUP_CHUNK_BYTES = 4 * 1024 * 1024;
export const BACKUP_CHUNK_BODY_BYTES = Math.ceil((BACKUP_CHUNK_BYTES * 4) / 3) + 4096;
// A gzipped snapshot at most (its JSON must also fit in one string to be read back)
export const BACKUP_MAX_BYTES = 256 * 1024 * 1024;
// Kept: the last 14 snapshots, and the newest of each day for 30 days
export const BACKUP_KEEP_LAST = 14;
export const BACKUP_KEEP_DAYS = 30;

export const backupIdSchema = z.string().regex(/^\d{13}-[a-f0-9]{8}$/);
export const backupUploadIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const base64Schema = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
// What a snapshot holds, by table or area, for the list ("312 chats, 4 meetings")
export const backupCountsSchema = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/), z.number().int().nonnegative())
  .refine(counts => Object.keys(counts).length <= 100, 'Too many counts.');

export const backupMetaSchema = z.object({
  id: backupIdSchema,
  createdAt: z.number().int().nonnegative(),
  bytes: z.number().int().positive().max(BACKUP_MAX_BYTES),
  sha256: sha256Schema,
  // The extension's database version the snapshot was taken at
  dbVersion: z.number().int().positive().max(100_000),
  extensionVersion: z.string().max(40),
  counts: backupCountsSchema,
});
export type BackupMeta = z.infer<typeof backupMetaSchema>;

export const backupBeginRequestSchema = backupMetaSchema.omit({ id: true }).extend({ requestId: requestIdSchema });
export type BackupBeginRequest = z.infer<typeof backupBeginRequestSchema>;
export const backupBeginReplySchema = z.object({
  ok: z.literal(true),
  uploadId: backupUploadIdSchema,
  chunkBytes: z.number().int().positive(),
});

export const backupChunkRequestSchema = z.object({ data: base64Schema.min(1).max(BACKUP_CHUNK_BODY_BYTES) });
export const backupCommitReplySchema = z.object({ ok: z.literal(true), snapshot: backupMetaSchema });

export const backupSecretsStateSchema = z.object({
  storedAt: z.number().int().nonnegative().nullable(),
  count: z.number().int().nonnegative(),
});
export const backupListReplySchema = z.object({
  ok: z.literal(true),
  snapshots: z.array(backupMetaSchema).max(200),
  secrets: backupSecretsStateSchema,
});
export type BackupListReply = z.infer<typeof backupListReplySchema>;

export const backupReadRequestSchema = z.object({ index: z.number().int().nonnegative().max(10_000) });
export const backupReadReplySchema = z.object({
  ok: z.literal(true),
  index: z.number().int().nonnegative(),
  chunks: z.number().int().positive(),
  data: base64Schema.max(BACKUP_CHUNK_BODY_BYTES),
});

// A name in the extension's vault, e.g. "llm:openai"
export const backupSecretRefSchema = z.string().regex(/^[A-Za-z0-9:._@/-]{1,200}$/);
export const BACKUP_SECRETS_MAX = 500;
export const backupSecretsSchema = z
  .record(backupSecretRefSchema, z.string().min(1).max(20_000))
  .refine(secrets => Object.keys(secrets).length <= BACKUP_SECRETS_MAX, 'Too many keys.');
export const backupSecretsPutRequestSchema = z.object({ requestId: requestIdSchema, secrets: backupSecretsSchema });
export const backupSecretsGetReplySchema = z.object({
  ok: z.literal(true),
  secrets: backupSecretsSchema,
  storedAt: z.number().int().nonnegative().nullable(),
});

// ── Obsidian vault on the Mac ─────────────────────────────────────────────────────────────────────
// Nex Brain reads and writes the user's Obsidian vault on disk, so the browser needs no folder picker (Brave
// ships without one). The vault is chosen once (choose); every other call names it by id and every path is
// relative to it: Nex Brain resolves each one with realpath and refuses anything that leaves the vault.

export const OBSIDIAN_ROUTES = {
  // Vaults Obsidian knows (its obsidian.json) and the one chosen
  vaults: '/v1/obsidian/vaults',
  choose: '/v1/obsidian/choose',
  forget: '/v1/obsidian/forget',
  // Note paths, mtimes and sizes, a page at a time (since=mtime for what changed)
  notes: '/v1/obsidian/notes',
  // Up to OBSIDIAN_LIMITS.readBatch notes at once
  read: '/v1/obsidian/read',
  write: '/v1/obsidian/write',
  remove: '/v1/obsidian/remove',
  search: '/v1/obsidian/search',
} as const;

export const OBSIDIAN_LIMITS = {
  // A note larger than this is never read or written
  noteBytes: 1_000_000,
  readBatch: 50,
  readBatchBytes: 4_000_000,
  listPage: 1000,
  // Notes walked in one vault at most
  maxNotes: 20_000,
  searchResults: 50,
  // Bytes a search reads before it stops and says it was cut short
  searchScanBytes: 40_000_000,
} as const;

// The one folder of the vault Nex Brain writes in (any case), and the line every note it writes carries in its front
// matter. Both are fixed here, never chosen by the caller: only a note under the folder with the marker is replaced
// or removed.
export const OBSIDIAN_WRITE_ROOT = 'Nex Copilot';
export const OBSIDIAN_MARKER = 'source: avi-copilot';

/** Whether a note path is in the copilot's own folder ("Nex Copilot/…", any case). */
export function isInObsidianWriteRoot(value: string): boolean {
  const [top, ...rest] = value.split('/');
  return rest.length > 0 && top.toLowerCase() === OBSIDIAN_WRITE_ROOT.toLowerCase();
}

/**
 * A note's path inside a vault: relative, "/"-separated, ending in .md, no "..", no hidden parts (".obsidian",
 * ".trash", dotfiles), no backslashes or control characters. Percent signs stay as they are: nothing decodes them.
 */
export function isSafeNotePath(value: string): boolean {
  if (typeof value !== 'string' || value.length > 500 || !isSafeRelativePath(value)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (!/\.md$/i.test(value)) return false;
  return value.split('/').every(part => !part.startsWith('.') && part.length <= 255 && part.trim() === part);
}

export const vaultIdSchema = z.string().regex(/^[a-f0-9]{16}$/);
export const notePathSchema = z
  .string()
  .min(4)
  .max(500)
  .refine(isSafeNotePath, 'A Markdown note inside the vault, without ".." or hidden folders.');

export const obsidianVaultSchema = z.object({
  id: vaultIdSchema,
  name: z.string().max(200),
  path: z.string().max(1000),
  // 'obsidian': in Obsidian's own list; 'chosen': a folder the user typed
  found: z.enum(['obsidian', 'chosen']),
  // Whether the folder is still there and still an Obsidian vault
  usable: z.boolean(),
});
export type ObsidianVault = z.infer<typeof obsidianVaultSchema>;

export const obsidianVaultsReplySchema = z.object({
  ok: z.literal(true),
  vaults: z.array(obsidianVaultSchema).max(100),
  chosen: obsidianVaultSchema.nullable(),
});
export type ObsidianVaultsReply = z.infer<typeof obsidianVaultsReplySchema>;

export const obsidianChooseRequestSchema = z.object({
  requestId: requestIdSchema,
  path: z.string().min(1).max(1000),
  // Choose it only if it is still this vault: a sync choosing a saved path again never switches to another folder
  expectVaultId: vaultIdSchema.optional(),
});
export const obsidianChooseReplySchema = z.object({ ok: z.literal(true), vault: obsidianVaultSchema });

export const obsidianNotesRequestSchema = z.object({
  vaultId: vaultIdSchema,
  // Only notes changed after this time (ms); 0 lists them all
  since: z.number().nonnegative().default(0),
  // The last path of the page before: pages are in path order
  cursor: z.string().max(500).nullable().default(null),
  limit: z.number().int().min(1).max(OBSIDIAN_LIMITS.listPage).default(500),
});
export const noteMetaSchema = z.object({
  path: z.string().max(500),
  mtime: z.number().nonnegative(),
  size: z.number().int().nonnegative(),
});
export type NoteMeta = z.infer<typeof noteMetaSchema>;
export const obsidianNotesReplySchema = z.object({
  ok: z.literal(true),
  notes: z.array(noteMetaSchema).max(OBSIDIAN_LIMITS.listPage),
  next: z.string().max(500).nullable(),
  // The vault has more notes than Nex Brain walks
  capped: z.boolean(),
});

export const obsidianReadRequestSchema = z.object({
  vaultId: vaultIdSchema,
  paths: z.array(notePathSchema).min(1).max(OBSIDIAN_LIMITS.readBatch),
});
export const obsidianReadReplySchema = z.object({
  ok: z.literal(true),
  notes: z
    .array(
      z.object({
        path: z.string().max(500),
        text: z.string().max(OBSIDIAN_LIMITS.noteBytes),
        mtime: z.number().nonnegative(),
        size: z.number().int().nonnegative(),
      }),
    )
    .max(OBSIDIAN_LIMITS.readBatch),
  skipped: z
    .array(
      z.object({
        path: z.string().max(500),
        reason: z.enum(['missing', 'too_large', 'not_allowed', 'batch_full']),
      }),
    )
    .max(OBSIDIAN_LIMITS.readBatch),
});

export const obsidianWriteRequestSchema = z.object({
  requestId: requestIdSchema,
  vaultId: vaultIdSchema,
  path: notePathSchema.refine(isInObsidianWriteRoot, 'Nex Brain only writes in the Nex Copilot folder.'),
  text: z.string().max(OBSIDIAN_LIMITS.noteBytes),
  // 'create' never replaces a file; 'overwrite' replaces only a note carrying OBSIDIAN_MARKER (or makes a new one)
  mode: z.enum(['create', 'overwrite']),
});
export type ObsidianWriteRequest = z.infer<typeof obsidianWriteRequestSchema>;
export const obsidianWriteReplySchema = z.object({
  ok: z.literal(true),
  path: z.string().max(500),
  mtime: z.number().nonnegative(),
  created: z.boolean(),
});

// Removes only a note in the copilot's folder that carries the marker: the copilot's own, never the user's
export const obsidianRemoveRequestSchema = z.object({
  requestId: requestIdSchema,
  vaultId: vaultIdSchema,
  path: notePathSchema.refine(isInObsidianWriteRoot, 'Nex Brain only removes notes in the Nex Copilot folder.'),
});
export const obsidianRemoveReplySchema = z.object({ ok: z.literal(true), removed: z.boolean() });

export const obsidianSearchRequestSchema = z.object({
  vaultId: vaultIdSchema,
  query: z.string().trim().min(2).max(200),
  limit: z.number().int().min(1).max(OBSIDIAN_LIMITS.searchResults).default(20),
});
export const obsidianSearchReplySchema = z.object({
  ok: z.literal(true),
  results: z
    .array(
      z.object({
        path: z.string().max(500),
        title: z.string().max(300),
        snippet: z.string().max(400),
        mtime: z.number().nonnegative(),
      }),
    )
    .max(OBSIDIAN_LIMITS.searchResults),
  truncated: z.boolean(),
});

// ── The Mac's Calendar ────────────────────────────────────────────────────────────────────────────
// Nex Brain reads macOS Calendar (EventKit), which syncs every Google, Workspace, iCloud or Exchange account
// added under System Settings › Internet Accounts. Read-only. Event text is written by whoever sent the invite:
// it is data, never instructions.

export const CALENDAR_ROUTES = {
  status: '/v1/calendar/status',
  // Asks macOS for access (the one-time Calendars prompt)
  request: '/v1/calendar/request',
  events: '/v1/calendar/events',
} as const;

export const CALENDAR_LIMITS = {
  events: 500,
  calendars: 300,
  notesChars: 2000,
  windowMs: 32 * 24 * 60 * 60 * 1000,
} as const;

// EventKit's authorization, in words: 'write_only' (macOS 14+) cannot read events
export const CALENDAR_ACCESS = [
  'granted',
  'not_determined',
  'denied',
  'restricted',
  'write_only',
  'unavailable',
] as const;
export type CalendarAccess = (typeof CALENDAR_ACCESS)[number];

export const macCalendarSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().max(200),
  // The account it syncs from (e.g. "Google", "iCloud", an email address)
  account: z.string().max(200),
  color: z.string().max(20).nullable(),
});
export type MacCalendar = z.infer<typeof macCalendarSchema>;

export const calendarStatusReplySchema = z.object({
  ok: z.literal(true),
  access: z.enum(CALENDAR_ACCESS),
  calendars: z.array(macCalendarSchema).max(CALENDAR_LIMITS.calendars),
  // A plain sentence when access is missing: what to do on the Mac
  message: z.string().max(1000).nullable(),
});
export type CalendarStatusReply = z.infer<typeof calendarStatusReplySchema>;

export const calendarEventsRequestSchema = z
  .object({
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    // Only these calendars; null for all
    calendarIds: z.array(z.string().min(1).max(200)).max(CALENDAR_LIMITS.calendars).nullable().default(null),
  })
  .refine(range => range.to > range.from && range.to - range.from <= CALENDAR_LIMITS.windowMs, {
    message: 'A window of up to 32 days.',
  });
export type CalendarEventsRequest = z.infer<typeof calendarEventsRequestSchema>;

export const macEventSchema = z.object({
  id: z.string().min(1).max(400),
  calendarId: z.string().max(200),
  calendar: z.string().max(200),
  title: z.string().max(500),
  start: z.number(),
  end: z.number(),
  allDay: z.boolean(),
  location: z.string().max(1000),
  notes: z.string().max(CALENDAR_LIMITS.notesChars),
  url: z.string().max(2000).nullable(),
  joinUrl: z.string().max(2000).nullable(),
});
export type MacEvent = z.infer<typeof macEventSchema>;

export const calendarEventsReplySchema = z.object({
  ok: z.literal(true),
  events: z.array(macEventSchema).max(CALENDAR_LIMITS.events),
  truncated: z.boolean(),
});

const MEETING_LINKS = /https:\/\/[^\s"<>\\]+/gi;

/**
 * The first meeting link in a text. Invites can come from anyone, so a link counts only when its host is exactly
 * a meeting service (Meet, Zoom, Teams), never a look-alike such as evilzoom.us.
 */
export function meetingLinkIn(text: string): string | null {
  for (const [candidate] of text.matchAll(MEETING_LINKS)) {
    try {
      // A link at the end of a sentence or in brackets keeps no trailing punctuation
      const url = new URL(candidate.replace(/[),.;\]>]+$/, ''));
      const host = url.hostname.toLowerCase();
      const meet = host === 'meet.google.com' && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(url.pathname);
      const zoom = (host === 'zoom.us' || host.endsWith('.zoom.us')) && url.pathname.startsWith('/j/');
      const teams =
        (host === 'teams.microsoft.com' && url.pathname.startsWith('/l/meetup-join/')) ||
        (host === 'teams.live.com' && url.pathname.startsWith('/meet/'));
      if (meet || zoom || teams) return url.toString();
    } catch {
      // Not a link
    }
  }
  return null;
}

// ── Replies, in general ───────────────────────────────────────────────────────────────────────────

/** Whether a parsed body is the companion's error reply. */
export function isErrorReply(value: unknown): value is ErrorReply {
  return errorReplySchema.safeParse(value).success;
}
