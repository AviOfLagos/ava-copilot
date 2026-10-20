import type { z } from 'zod';
import { abortableSleep, AppError, CircuitBreaker, RETRY_POLICIES, toAppError, withRetry } from '@extension/shared';
import type { RetryPolicy } from '@extension/shared';
import { deleteSecret, getSecret, putSecret } from '@extension/storage';
import {
  artifactCreateReplySchema,
  artifactListReplySchema,
  artifactOpenReplySchema,
  COMPANION_HOST,
  COMPANION_ROUTES,
  errorReplySchema,
  ghReplySchema,
  healthReplySchema,
  MEET_ROUTES,
  meetSayReplySchema,
  meetStatusReplySchema,
  okReplySchema,
  pairReplySchema,
  sandboxRunReplySchema,
  sessionCreateReplySchema,
  sessionEventSchema,
  toolCallReplySchema,
  toolListReplySchema,
  workflowRunReplySchema,
  workflowSyncReplySchema,
} from '@src/shared/lib/protocol/companion';
import type {
  ArtifactCreateRequest,
  GhRequest,
  HealthReply,
  SandboxRunRequest,
  SessionAnswerRequest,
  SessionCreateRequest,
  SessionEvent,
  ToolCallRequest,
  WorkflowPutRequest,
  MeetJoinRequest,
  MeetSayRequest,
} from '@src/shared/lib/protocol/companion';
import { BRAIN_TOKEN_REF, brainSettingsStore } from './state';

/**
 * The extension's side of Nex Brain: one HTTP client over the shared protocol, in the background only
 * (it reads the token from the vault). Reads are retried with back-off (RETRY_POLICIES.companion); calls
 * that do something are sent once, with a request id, so a repeat by hand gets the first answer and never
 * runs twice. A breaker per address stops calling a companion that keeps failing, and remembers it in
 * session storage across worker restarts.
 */

export const NOT_RUNNING_MESSAGE = 'Nex Brain is not running on your Mac. Start it, then try again.';
const BREAKER_KEY = 'brain-breaker';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface CompanionClientDeps {
  fetch: typeof fetch;
  port: () => Promise<number>;
  token: () => Promise<string | null>;
  breakerState: {
    load: () => Promise<ReturnType<CircuitBreaker['snapshot']> | undefined>;
    save: (snapshot: ReturnType<CircuitBreaker['snapshot']>) => Promise<void>;
  };
  retry?: Partial<RetryPolicy>;
}

interface CallOptions<S extends z.ZodType> {
  // No GET: the browser sends no Origin on an extension's GET, and the companion requires one
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  schema: S;
  body?: unknown;
  // Safe to repeat: retried on errors that may pass
  idempotent?: boolean;
  auth?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  // A check the user asked for goes through even while the breaker is open
  bypassBreaker?: boolean;
  retry?: Partial<RetryPolicy>;
}

const sessionStorage = () => (typeof chrome !== 'undefined' ? chrome.storage?.session : undefined);

const defaultDeps: CompanionClientDeps = {
  fetch: (input, init) => fetch(input, init),
  port: async () => (await brainSettingsStore.getSettings()).port,
  token: () => getSecret(BRAIN_TOKEN_REF),
  breakerState: {
    load: async () =>
      sessionStorage()
        ?.get(BREAKER_KEY)
        .then(items => items[BREAKER_KEY] as ReturnType<CircuitBreaker['snapshot']> | undefined)
        .catch(() => undefined),
    save: async snapshot => {
      await sessionStorage()
        ?.set({ [BREAKER_KEY]: snapshot })
        .catch(() => {});
    },
  },
};

export class CompanionClient {
  private breaker: CircuitBreaker | null = null;

  constructor(private readonly deps: CompanionClientDeps = defaultDeps) {}

  private async breakerFor(): Promise<CircuitBreaker> {
    if (!this.breaker) {
      const breaker = new CircuitBreaker();
      const saved = await this.deps.breakerState.load();
      if (saved) breaker.restore(saved);
      this.breaker = breaker;
    }
    return this.breaker;
  }

  async baseUrl(): Promise<string> {
    return `http://${COMPANION_HOST}:${await this.deps.port()}`;
  }

  private async call<S extends z.ZodType>(options: CallOptions<S>): Promise<z.infer<S>> {
    const base = await this.baseUrl();
    const headers: Record<string, string> = {};
    if (options.auth !== false) {
      const token = await this.deps.token();
      if (!token) throw new AppError('auth', 'Nex Brain is not paired with this browser yet.', { retryable: false });
      headers.Authorization = `Bearer ${token}`;
    }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const breaker = await this.breakerFor();

    const once = async (): Promise<z.infer<S>> => {
      let response: Response;
      try {
        response = await this.deps.fetch(`${base}${options.path}`, {
          method: options.method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          credentials: 'omit',
          cache: 'no-store',
          // The companion never redirects; anything that does is not it
          redirect: 'error',
          signal: AbortSignal.any([
            ...(options.signal ? [options.signal] : []),
            AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
          ]),
        });
      } catch (error) {
        const appError = toAppError(error);
        if (appError.kind === 'network') throw new AppError('network', NOT_RUNNING_MESSAGE, { cause: error });
        throw appError;
      }
      const reply = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        const parsed = errorReplySchema.safeParse(reply);
        const kind = parsed.success ? parsed.data.error.kind : response.status === 401 ? 'auth' : 'unavailable';
        const message = parsed.success ? parsed.data.error.message : `Nex Brain answered ${response.status}.`;
        throw new AppError(kind, message, {
          status: response.status,
          retryAfterMs: parsed.success ? parsed.data.error.retryAfterMs : undefined,
        });
      }
      const checked = options.schema.safeParse(reply);
      if (!checked.success) throw new AppError('invalid', 'Nex Brain sent an answer this version does not understand.');
      return checked.data;
    };

    const guarded = () => (options.bypassBreaker ? once() : breaker.call(once));
    try {
      return options.idempotent
        ? await withRetry(guarded, {
            ...RETRY_POLICIES.companion,
            ...this.deps.retry,
            ...options.retry,
            signal: options.signal,
          })
        : await guarded();
    } finally {
      await this.deps.breakerState.save(breaker.snapshot());
    }
  }

  // ── Pairing and health ──

  /** Trades a one-time code for a token, kept in the vault. */
  async pair(code: string, client = 'Nex Copilot'): Promise<z.infer<typeof pairReplySchema>> {
    const reply = await this.call({
      method: 'POST',
      path: COMPANION_ROUTES.pair,
      schema: pairReplySchema,
      body: { code, client },
      auth: false,
      bypassBreaker: true,
      timeoutMs: 10_000,
    });
    await putSecret(BRAIN_TOKEN_REF, reply.token);
    return reply;
  }

  /** Tells the Mac to forget this browser (best effort) and forgets the token here. */
  async unpair(): Promise<void> {
    try {
      await this.call({
        method: 'POST',
        path: COMPANION_ROUTES.unpair,
        schema: okReplySchema,
        body: {},
        timeoutMs: 5000,
        bypassBreaker: true,
      });
    } catch {
      // Not running, or already forgotten: the token goes either way
    } finally {
      await deleteSecret(BRAIN_TOKEN_REF);
    }
  }

  health(options: { fresh?: boolean; signal?: AbortSignal; bypassBreaker?: boolean } = {}): Promise<HealthReply> {
    return this.call({
      method: 'POST',
      path: COMPANION_ROUTES.health,
      body: { fresh: Boolean(options.fresh) },
      schema: healthReplySchema,
      idempotent: true,
      retry: { attempts: 2 },
      timeoutMs: 8000,
      signal: options.signal,
      bypassBreaker: options.bypassBreaker,
    });
  }

  // ── Sandbox and gh (side effects: sent once) ──

  runSandbox(request: SandboxRunRequest, signal?: AbortSignal) {
    const seconds = request.policy?.timeoutSec ?? 300;
    return this.call({
      method: 'POST',
      path: COMPANION_ROUTES.sandboxRun,
      schema: sandboxRunReplySchema,
      body: request,
      signal,
      timeoutMs: seconds * 1000 + 30_000,
    });
  }

  gh(request: GhRequest, signal?: AbortSignal) {
    return this.call({
      method: 'POST',
      path: COMPANION_ROUTES.gh,
      schema: ghReplySchema,
      body: request,
      signal,
      timeoutMs: 90_000,
    });
  }

  // ── MCP tools ──

  listTools(signal?: AbortSignal) {
    return this.call({
      method: 'POST',
      path: COMPANION_ROUTES.tools,
      body: {},
      schema: toolListReplySchema,
      idempotent: true,
      signal,
    });
  }

  callTool(request: ToolCallRequest, signal?: AbortSignal) {
    return this.call({
      method: 'POST',
      path: COMPANION_ROUTES.toolCall,
      schema: toolCallReplySchema,
      body: request,
      signal,
      timeoutMs: 90_000,
    });
  }

  // ── Agent sessions ──

  createSession(request: SessionCreateRequest, signal?: AbortSignal) {
    return this.call({
      method: 'POST',
      path: COMPANION_ROUTES.sessions,
      schema: sessionCreateReplySchema,
      body: request,
      signal,
      timeoutMs: 60_000,
    });
  }

  sendMessage(sessionId: string, request: { requestId: string; message: string }, signal?: AbortSignal) {
    return this.call({
      method: 'POST',
      path: `${COMPANION_ROUTES.sessions}/${encodeURIComponent(sessionId)}/messages`,
      schema: okReplySchema,
      body: request,
      signal,
    });
  }

  answer(sessionId: string, request: SessionAnswerRequest, signal?: AbortSignal) {
    return this.call({
      method: 'POST',
      path: `${COMPANION_ROUTES.sessions}/${encodeURIComponent(sessionId)}/answer`,
      schema: okReplySchema,
      body: request,
      signal,
    });
  }

  cancelSession(sessionId: string, signal?: AbortSignal) {
    return this.call({
      method: 'POST',
      path: `${COMPANION_ROUTES.sessions}/${encodeURIComponent(sessionId)}/cancel`,
      schema: okReplySchema,
      body: {},
      idempotent: true,
      signal,
    });
  }

  /**
   * Follows a session's events from a cursor until `until` says stop, the session ends or the signal
   * aborts. A dropped connection is picked up again from the next index, with back-off, so no event is
   * missed or repeated. Returns the cursor to resume from.
   */
  async followSession(
    sessionId: string,
    options: {
      cursor?: number;
      signal: AbortSignal;
      onEvent: (event: SessionEvent) => void | Promise<void>;
      until?: (event: SessionEvent) => boolean;
    },
  ): Promise<number> {
    let cursor = options.cursor ?? 0;
    let done = false;
    const base = await this.baseUrl();
    while (!done && !options.signal.aborted) {
      await withRetry(
        async () => {
          const token = await this.deps.token();
          if (!token)
            throw new AppError('auth', 'Nex Brain is not paired with this browser yet.', { retryable: false });
          let response: Response;
          try {
            response = await this.deps.fetch(
              `${base}${COMPANION_ROUTES.sessions}/${encodeURIComponent(sessionId)}/events`,
              {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ cursor }),
                credentials: 'omit',
                cache: 'no-store',
                redirect: 'error',
                signal: options.signal,
              },
            );
          } catch (error) {
            const appError = toAppError(error);
            throw appError.kind === 'network'
              ? new AppError('network', NOT_RUNNING_MESSAGE, { cause: error })
              : appError;
          }
          if (!response.ok || !response.body) {
            const parsed = errorReplySchema.safeParse(await response.json().catch(() => null));
            throw new AppError(
              parsed.success ? parsed.data.error.kind : 'unavailable',
              parsed.success ? parsed.data.error.message : 'The session stream is not available.',
              {
                status: response.status,
              },
            );
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done: ended, value } = await reader.read();
            if (ended) break;
            buffer += decoder.decode(value, { stream: true });
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              if (!line) continue;
              const parsed = sessionEventSchema.safeParse(JSON.parse(line));
              // An error line, or something newer than this version knows: skipped
              if (!parsed.success) continue;
              cursor = parsed.data.index + 1;
              await options.onEvent(parsed.data);
              if (parsed.data.type === 'session.ended' || options.until?.(parsed.data)) {
                done = true;
                await reader.cancel().catch(() => {});
                return;
              }
            }
          }
        },
        { ...RETRY_POLICIES.companion, ...this.deps.retry, signal: options.signal },
      );
      // The companion ends a stream now and then; pick it up again after a breath
      if (!done) await abortableSleep(250, options.signal).catch(() => {});
    }
    return cursor;
  }

  // ── Routines on the Mac ──

  pushWorkflow(request: WorkflowPutRequest) {
    return this.call({
      method: 'PUT',
      path: `${COMPANION_ROUTES.workflows}/${encodeURIComponent(request.workflow.id)}`,
      schema: okReplySchema.loose(),
      body: request,
      // Putting the same routine twice leaves the same routine
      idempotent: true,
    });
  }

  deleteWorkflow(id: string) {
    return this.call({
      method: 'DELETE',
      path: `${COMPANION_ROUTES.workflows}/${encodeURIComponent(id)}`,
      schema: okReplySchema,
      idempotent: true,
    });
  }

  runWorkflow(id: string, requestId: string) {
    return this.call({
      method: 'POST',
      path: `${COMPANION_ROUTES.workflows}/${encodeURIComponent(id)}/run`,
      schema: workflowRunReplySchema,
      body: { requestId },
    });
  }

  answerWorkflowStep(request: { requestId: string; runId: string; nodeId: string; approved: boolean }) {
    return this.call({
      method: 'POST',
      path: `${COMPANION_ROUTES.workflows}/runs/answer`,
      schema: okReplySchema,
      body: request,
    });
  }

  syncWorkflows(cursor: number) {
    return this.call({
      method: 'POST',
      path: COMPANION_ROUTES.workflowSync,
      body: { cursor: Math.max(0, Math.floor(cursor)) },
      schema: workflowSyncReplySchema,
      idempotent: true,
    });
  }

  ackWorkflows(requestId: string, outboxIds: string[]) {
    return this.call({
      method: 'POST',
      path: COMPANION_ROUTES.workflowAck,
      schema: okReplySchema,
      body: { requestId, outboxIds },
      idempotent: true,
    });
  }

  // ── Artifacts ──

  listArtifacts(signal?: AbortSignal) {
    return this.call({
      method: 'POST',
      path: COMPANION_ROUTES.artifactList,
      body: {},
      schema: artifactListReplySchema,
      idempotent: true,
      signal,
    });
  }

  createArtifact(request: ArtifactCreateRequest, signal?: AbortSignal) {
    return this.call({
      method: 'POST',
      path: COMPANION_ROUTES.artifacts,
      schema: artifactCreateReplySchema,
      body: request,
      signal,
      timeoutMs: 15 * 60_000,
    });
  }

  /** The Avi Studio address for an artifact, with a one-time token in its fragment; only the companion's own. */
  async openArtifact(artifactId: string): Promise<string> {
    const reply = await this.call({
      method: 'POST',
      path: `${COMPANION_ROUTES.artifacts}/${encodeURIComponent(artifactId)}/open`,
      schema: artifactOpenReplySchema,
      body: {},
    });
    const url = new URL(reply.url);
    const base = new URL(await this.baseUrl());
    if (url.origin !== base.origin || !url.pathname.startsWith(`${COMPANION_ROUTES.studio}/`)) {
      throw new AppError('forbidden', 'Nex Brain gave an address that is not its own.');
    }
    return url.toString();
  }

  // ── Ava in a Google Meet call ──

  meetStatus(signal?: AbortSignal) {
    return this.call({
      method: 'POST',
      path: MEET_ROUTES.status,
      body: {},
      schema: meetStatusReplySchema,
      idempotent: true,
      retry: { attempts: 2 },
      timeoutMs: 8000,
      signal,
    });
  }

  /** Opens Ava's browser at Google's sign-in page, for the user to sign in to her account by hand. */
  meetSignin() {
    return this.call({ method: 'POST', path: MEET_ROUTES.signin, body: {}, schema: meetStatusReplySchema });
  }

  meetJoin(request: MeetJoinRequest) {
    return this.call({
      method: 'POST',
      path: MEET_ROUTES.join,
      body: request,
      schema: meetStatusReplySchema,
      timeoutMs: 60_000,
    });
  }

  /** Plays approved words into the call: a side effect, sent once. */
  meetSay(request: MeetSayRequest, signal?: AbortSignal) {
    return this.call({
      method: 'POST',
      path: MEET_ROUTES.say,
      body: request,
      schema: meetSayReplySchema,
      timeoutMs: 45_000,
      signal,
    });
  }

  /** Stops her at once; goes through even while the breaker is open. */
  meetStop() {
    return this.call({
      method: 'POST',
      path: MEET_ROUTES.stop,
      body: {},
      schema: meetStatusReplySchema,
      idempotent: true,
      bypassBreaker: true,
      timeoutMs: 5000,
    });
  }

  meetLeave() {
    return this.call({
      method: 'POST',
      path: MEET_ROUTES.leave,
      body: {},
      schema: meetStatusReplySchema,
      idempotent: true,
      bypassBreaker: true,
      timeoutMs: 15_000,
    });
  }
}

export const companionClient = new CompanionClient();
