import { AppError, RETRY_POLICIES, toAppError, withRetry } from '@extension/shared';
import type { CircuitBreaker, RetryPolicy } from '@extension/shared';
import {
  checkConnectorUrl,
  connectorBoundTo,
  catalogConnectorUrl,
  connectorCatalogEntry,
  connectorToolState,
  effectiveToolPolicy,
} from '@extension/storage';
import type { ConnectorCatalogId, ConnectorRecord, ToolFingerprint, ToolPolicy } from '@extension/storage';
import { connectorBreaker, dropConnectorBreaker, saveConnectorBreakers } from './breakers';
import { listAllTools, withMcpSession } from './client';
import type { SessionInfo } from './client';
import { companionToolBridge, needsCompanion } from './companion';
import { allSecretRefs, clientRef, tokenHeaders, tokenRef } from './credentials';
import type { SecretVaultLike } from './credentials';
import { connectorError } from './errors';
import { hashTools } from './fingerprint';
import type { ListedTool } from './fingerprint';
import type { OAuthManager } from './oauth';
import { formatToolResult } from './result';
import type { FormattedResult } from './result';
import { checkArgs } from './schema';
import type { Client, FetchLike } from './sdk';
import type { ConnectorStore } from './store';

/**
 * Connectors: remote MCP servers (and, through the Mac companion, local ones) whose tools the agent and routines
 * may use. This is the one place that talks to them, and it decides every call:
 * - a tool runs only if the user approved it as it is now (its fingerprint), and as they said (read / ask / off);
 * - arguments are checked against the tool's schema before anything is sent;
 * - reads retry with back-off, writes never; one circuit breaker per server;
 * - one short session per piece of work, with the sign-in renewed when it runs out.
 */

export const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 120_000;
// A tool's definition is read again before a call when the last reading is older than this
export const RECHECK_MS = 10 * 60_000;

export interface ConnectorServiceDeps {
  store: ConnectorStore;
  vault: SecretVaultLike;
  oauth: OAuthManager;
  fetch?: FetchLike;
  now?: () => number;
  breaker?: (connectorId: string) => Promise<CircuitBreaker>;
  saveBreakers?: () => Promise<void>;
  // Tells the user a connector needs them to sign in again (an Inbox item)
  alert?: (connector: ConnectorRecord, reason: string) => Promise<void>;
  // Stand-ins for tests: how reads are retried
  retry?: Partial<RetryPolicy>;
}

export interface NewConnector {
  name: string;
  url?: string;
  authKind?: ConnectorRecord['authKind'];
  token?: string;
  tokenHeader?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  workspaceIds: string[];
  catalogId?: ConnectorCatalogId | null;
  timeoutMs?: number;
}

export interface ConnectorChanges {
  name?: string;
  url?: string;
  workspaceIds?: string[];
  enabled?: boolean;
  token?: string;
  tokenHeader?: string | null;
  clientId?: string | null;
  clientSecret?: string;
  scope?: string | null;
  timeoutMs?: number;
  // How a custom server is signed in to; a well-known server's is fixed
  authKind?: ConnectorRecord['authKind'];
}

export interface RefreshSummary {
  tools: number;
  added: string[];
  changed: string[];
  removed: string[];
}

// Who wants to use a tool: the chat's workspace, and the agent it runs as (an agent may use only its own)
export interface CallScope {
  workspaceId: string | null;
  agentId?: string | null;
}

export interface PreparedCall {
  connector: ConnectorRecord;
  fingerprint: ToolFingerprint;
  policy: Exclude<ToolPolicy, 'off'>;
  args: Record<string, unknown>;
}

export type Preparation = PreparedCall | { refused: string };

export interface UsableTool {
  connector: ConnectorRecord;
  fingerprint: ToolFingerprint;
  policy: Exclude<ToolPolicy, 'off'>;
}

function clampTimeout(ms: number | undefined): number {
  if (!ms || !Number.isFinite(ms)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(ms)));
}

const lower = (text: string) => text.trim().toLowerCase();

/** The scheme, host and port of an address, or '' when there is none. */
function originOf(url: string | null | undefined): string {
  try {
    return url ? new URL(url).origin : '';
  } catch {
    return '';
  }
}

export class ConnectorService {
  constructor(private readonly deps: ConnectorServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  get(id: string): Promise<ConnectorRecord | undefined> {
    return this.deps.store.get(id);
  }

  list(): Promise<ConnectorRecord[]> {
    return this.deps.store.list();
  }

  private async mustGet(id: string): Promise<ConnectorRecord> {
    const connector = await this.deps.store.get(id);
    if (!connector) throw new AppError('not_found', 'That connector does not exist any more.');
    return connector;
  }

  // ── Adding and changing ───────────────────────────────────────────────────────────────────────

  /** Adds a connector. Its secrets go to the vault; the record keeps their last characters only. */
  async add(input: NewConnector): Promise<ConnectorRecord> {
    const entry = connectorCatalogEntry(input.catalogId ?? null);
    const rawUrl = entry ? catalogConnectorUrl(entry, input.url) : (input.url ?? '');
    const checked = checkConnectorUrl(rawUrl);
    if ('error' in checked) throw new AppError('invalid', urlProblem(checked.error));
    const authKind = entry?.auth ?? input.authKind ?? 'none';
    const id = crypto.randomUUID();
    const now = this.now();
    const record: ConnectorRecord = {
      id,
      name: input.name.trim() || entry?.name || checked.url.host,
      kind: 'mcp_http',
      url: checked.url.href,
      authKind,
      secretRef: authKind === 'token' ? tokenRef(id) : authKind === 'oauth' ? clientRef(id) : null,
      workspaceIds: [...new Set(input.workspaceIds)],
      status: authKind === 'none' ? 'connected' : 'needs_auth',
      toolPolicy: {},
      lastError: null,
      lastErrorKind: null,
      createdAt: now,
      updatedAt: now,
      catalogId: entry?.id ?? null,
      transport: 'auto',
      timeoutMs: clampTimeout(input.timeoutMs),
      tokenHeader: authKind === 'token' ? input.tokenHeader?.trim() || null : null,
      oauth:
        authKind === 'oauth'
          ? {
              clientId: input.clientId?.trim() || null,
              hasClientSecret: Boolean(input.clientSecret?.trim()),
              scope: entry?.scope ?? (input.scope?.trim() || null),
              authParams: entry?.authParams,
            }
          : null,
      credential: null,
      toolsCheckedAt: null,
      serverInfo: null,
    };
    if (authKind === 'oauth' && entry?.needsClient && !record.oauth?.clientId) {
      throw new AppError('invalid', `${record.name} needs the client ID of your own app to sign in.`);
    }
    if (authKind === 'token' && input.token?.trim()) {
      await this.deps.vault.put(tokenRef(id), input.token.trim());
      record.credential = { last4: lastChars(input.token), savedAt: now, expiresAt: null };
      record.status = 'connected';
    }
    if (authKind === 'oauth' && record.oauth?.clientId) {
      await this.deps.vault.put(
        clientRef(id),
        JSON.stringify({ client_id: record.oauth.clientId, client_secret: input.clientSecret?.trim() || undefined }),
      );
    }
    await this.deps.store.put(record);
    return record;
  }

  /**
   * Adds a connector and, when nothing more is needed, reads its tools. A server added as needing no sign-in
   * that asks for one anyway is switched to signing in, so the user gets a "Sign in" button and no dead end.
   */
  async addAndConnect(
    input: NewConnector,
  ): Promise<{ connector: ConnectorRecord; summary: RefreshSummary | null; refreshError: string | null }> {
    let connector = await this.add(input);
    if (connector.status !== 'connected') return { connector, summary: null, refreshError: null };
    try {
      const summary = await this.refresh(connector.id);
      return { connector: (await this.get(connector.id)) ?? connector, summary, refreshError: null };
    } catch (error) {
      const refreshError = toAppError(error).message;
      connector = (await this.get(connector.id)) ?? connector;
      if (connector.authKind === 'none' && connector.status === 'needs_auth') {
        connector = await this.update(connector.id, { authKind: 'oauth' });
        return { connector, summary: null, refreshError: null };
      }
      return { connector, summary: null, refreshError };
    }
  }

  /** Changes a connector. A new address is another server: its tools and sign-in start over. */
  async update(id: string, changes: ConnectorChanges): Promise<ConnectorRecord> {
    const connector = await this.mustGet(id);
    const next: Partial<ConnectorRecord> = {};
    if (changes.name !== undefined && changes.name.trim()) next.name = changes.name.trim();
    if (changes.workspaceIds) next.workspaceIds = [...new Set(changes.workspaceIds)];
    if (changes.timeoutMs !== undefined) next.timeoutMs = clampTimeout(changes.timeoutMs);
    if (changes.authKind !== undefined && changes.authKind !== connector.authKind) {
      if (connector.catalogId) throw new AppError('invalid', `${connector.name}'s sign-in is fixed.`);
      // Another way in: whatever was saved for the old one goes, and the connector waits for the new one
      for (const ref of allSecretRefs(id)) await this.deps.vault.delete(ref);
      if (connector.authKind === 'oauth') await this.deps.oauth.signOut(id);
      connector.authKind = changes.authKind;
      next.authKind = changes.authKind;
      next.secretRef =
        changes.authKind === 'token' ? tokenRef(id) : changes.authKind === 'oauth' ? clientRef(id) : null;
      next.tokenHeader = null;
      next.oauth = changes.authKind === 'oauth' ? { clientId: null, hasClientSecret: false, scope: null } : null;
      connector.oauth = next.oauth;
      next.credential = null;
      next.lastError = null;
      next.lastErrorKind = null;
      next.status =
        connector.status === 'disabled' ? 'disabled' : changes.authKind === 'none' ? 'connected' : 'needs_auth';
      connector.status = next.status;
    }
    const checkedUrl = changes.url !== undefined ? checkConnectorUrl(changes.url) : null;
    if (checkedUrl && 'error' in checkedUrl) throw new AppError('invalid', urlProblem(checkedUrl.error));
    if (checkedUrl && 'url' in checkedUrl && checkedUrl.url.href !== connector.url) {
      if (connector.catalogId && !connectorCatalogEntry(connector.catalogId)?.ownServer) {
        throw new AppError('invalid', `${connector.name}'s address is fixed.`);
      }
      // A saved secret never follows the connector to another server: the user enters it again with the address
      if (checkedUrl.url.origin !== originOf(connector.url)) {
        if (connector.authKind === 'token' && !changes.token?.trim() && (await this.signedIn(connector))) {
          throw new AppError('invalid', 'The address changed: enter the token again for the new address.');
        }
        if (connector.authKind === 'oauth' && connector.oauth?.hasClientSecret && !changes.clientSecret?.trim()) {
          throw new AppError('invalid', 'The address changed: enter the client secret again for the new address.');
        }
      }
      next.url = checkedUrl.url.href;
      next.transport = 'auto';
      next.serverInfo = null;
      await this.deps.store.clearTools(id);
      if (connector.authKind === 'oauth') {
        await this.deps.oauth.signOut(id);
        next.credential = null;
        next.status = 'needs_auth';
      }
    }
    if (changes.tokenHeader !== undefined && connector.authKind === 'token') {
      next.tokenHeader = changes.tokenHeader?.trim() || null;
    }
    if (changes.token?.trim() && connector.authKind === 'token') {
      await this.deps.vault.put(tokenRef(id), changes.token.trim());
      next.credential = { last4: lastChars(changes.token), savedAt: this.now(), expiresAt: null };
      if (connector.status === 'needs_auth') next.status = 'connected';
    }
    const oauth = connector.oauth ?? { clientId: null, hasClientSecret: false, scope: null };
    if (connector.authKind === 'oauth' && (changes.clientId !== undefined || changes.clientSecret !== undefined)) {
      const clientId = changes.clientId === undefined ? oauth.clientId : changes.clientId?.trim() || null;
      const secret = changes.clientSecret?.trim();
      if (clientId) {
        const keepSecret = secret === undefined && clientId === oauth.clientId;
        const previous = keepSecret ? await this.deps.vault.get(clientRef(id)) : null;
        const previousSecret = previous
          ? (JSON.parse(previous) as { client_secret?: string }).client_secret
          : undefined;
        await this.deps.vault.put(
          clientRef(id),
          JSON.stringify({ client_id: clientId, client_secret: secret || previousSecret || undefined }),
        );
        next.oauth = { ...oauth, clientId, hasClientSecret: Boolean(secret || previousSecret) };
      } else {
        await this.deps.vault.delete(clientRef(id));
        next.oauth = { ...oauth, clientId: null, hasClientSecret: false };
      }
    }
    if (changes.scope !== undefined && connector.authKind === 'oauth' && !connector.catalogId) {
      next.oauth = { ...(next.oauth ?? oauth), scope: changes.scope?.trim() || null };
    }
    if (changes.enabled === false) next.status = 'disabled';
    if (changes.enabled === true && connector.status === 'disabled') {
      next.status = (await this.signedIn(connector)) ? 'connected' : 'needs_auth';
    }
    return (await this.deps.store.update(id, next)) ?? connector;
  }

  /** Removes a connector, its tools' approvals and every secret it had. */
  async remove(id: string): Promise<void> {
    for (const ref of allSecretRefs(id)) await this.deps.vault.delete(ref);
    await this.deps.store.remove(id);
    await dropConnectorBreaker(id).catch(() => {});
  }

  private async signedIn(connector: ConnectorRecord): Promise<boolean> {
    if (connector.authKind === 'none') return true;
    if (connector.authKind === 'token') return (await this.deps.vault.get(tokenRef(connector.id))) !== null;
    return (await this.deps.oauth.tokens(connector.id)) !== null;
  }

  // ── Sign-in ───────────────────────────────────────────────────────────────────────────────────

  async beginSignIn(id: string): Promise<{ authorizationUrl: string }> {
    const connector = await this.mustGet(id);
    if (connector.authKind !== 'oauth') throw new AppError('invalid', `${connector.name} does not sign in this way.`);
    const started = await this.deps.oauth.begin(connector);
    await this.deps.store.update(id, {
      oauth: {
        ...(connector.oauth ?? { clientId: null, hasClientSecret: false, scope: null }),
        authorizationServerUrl: started.authorizationServerUrl,
        issuer: started.issuer,
      },
    });
    return { authorizationUrl: started.authorizationUrl };
  }

  /** Finishes a sign-in, then reads the server's tools. */
  async finishSignIn(
    redirectUrl: string,
  ): Promise<{ connectorId: string; summary: RefreshSummary | null; error?: string }> {
    const { connectorId, tokens } = await this.deps.oauth.finish(redirectUrl);
    // "Connected" comes with the tools (reading them sets it), so nothing sees a connector with none yet
    await this.deps.store.update(connectorId, {
      lastError: null,
      lastErrorKind: null,
      credential: { last4: null, savedAt: tokens.saved_at, expiresAt: tokens.expires_at },
    });
    try {
      return { connectorId, summary: await this.refresh(connectorId) };
    } catch (thrown) {
      const error = toAppError(thrown);
      // Signed in all the same, unless the server refused the new token; the panel shows why the tools could not
      // be read
      const now = await this.get(connectorId);
      if (now?.status === 'needs_auth' && error.kind !== 'auth') {
        await this.deps.store.update(connectorId, { status: 'connected' });
      }
      return { connectorId, summary: null, error: error.message };
    }
  }

  /** A sign-in that came back refused or broken: the connector page says so until the next try. */
  async noteSignInFailure(id: string, message: string): Promise<void> {
    await this.deps.store.update(id, { lastError: message, lastErrorKind: null });
  }

  async signOut(id: string): Promise<void> {
    const connector = await this.mustGet(id);
    if (connector.authKind === 'oauth') await this.deps.oauth.signOut(id);
    if (connector.authKind === 'token') await this.deps.vault.delete(tokenRef(id));
    await this.deps.store.update(id, { status: 'needs_auth', credential: null });
  }

  // ── Talking to a server ───────────────────────────────────────────────────────────────────────

  private async credentials(
    connector: ConnectorRecord,
  ): Promise<{ headers: Record<string, string>; accessToken?: string }> {
    if (connector.authKind === 'token') {
      const token = await this.deps.vault.get(tokenRef(connector.id));
      if (!token) throw new AppError('auth', `Add ${connector.name}'s token in Connectors first.`);
      return { headers: tokenHeaders(connector.tokenHeader, token) };
    }
    if (connector.authKind === 'oauth') {
      const accessToken = await this.deps.oauth.accessToken(connector);
      return { headers: { Authorization: `Bearer ${accessToken}` }, accessToken };
    }
    return { headers: {} };
  }

  /**
   * One session with the server. A refused OAuth token is renewed once and the work tried again: the server
   * refused before doing anything, so this is safe even for a write.
   */
  private async session<T>(
    connector: ConnectorRecord,
    signal: AbortSignal | undefined,
    work: (client: Client, info: SessionInfo) => Promise<T>,
  ): Promise<{ value: T; info: SessionInfo }> {
    const credentials = await this.credentials(connector);
    const options = {
      url: connector.url ?? '',
      name: connector.name,
      transport: connector.transport ?? 'auto',
      headers: credentials.headers,
      timeoutMs: clampTimeout(connector.timeoutMs),
      signal,
      fetch: this.deps.fetch,
    };
    try {
      return await withMcpSession(options, work);
    } catch (thrown) {
      const error = connectorError(thrown, connector.name);
      if (error.kind !== 'auth' || connector.authKind !== 'oauth' || !credentials.accessToken) throw error;
      const renewed = await this.deps.oauth.renewAfterRefusal(connector, credentials.accessToken);
      return withMcpSession({ ...options, headers: { Authorization: `Bearer ${renewed}` } }, work);
    }
  }

  /** Runs through the connector's circuit breaker: a server that keeps failing is left alone for a while. */
  private async guarded<T>(connector: ConnectorRecord, work: () => Promise<T>): Promise<T> {
    const breaker = await (this.deps.breaker ?? connectorBreaker)(connector.id);
    if (breaker.state(this.now()) === 'open') {
      throw new AppError(
        'unavailable',
        `${connector.name} kept failing, so it is left alone for a couple of minutes. Try again after that.`,
        { retryable: false },
      );
    }
    try {
      return await breaker.call(work, () => this.now());
    } finally {
      await (this.deps.saveBreakers ?? saveConnectorBreakers)().catch(() => {});
    }
  }

  private retryPolicy(signal: AbortSignal | undefined): RetryPolicy {
    return { ...RETRY_POLICIES.connectorRead, ...this.deps.retry, signal };
  }

  /**
   * Records what a failure says about the connector: a sign-in to renew, or a server that does not answer. A
   * call's own failure (a slow tool, arguments the server refused) says nothing about the connector.
   */
  private async recordFailure(connector: ConnectorRecord, error: AppError, during: 'listing' | 'call'): Promise<void> {
    if (error.kind === 'auth') {
      // Only a connector that worked before is news: one refused from the start is shown where it was added
      const wasUsable = connector.status !== 'needs_auth' && connector.toolsCheckedAt !== null;
      await this.deps.store.update(connector.id, {
        status: 'needs_auth',
        lastError: error.message,
        lastErrorKind: 'auth',
      });
      // The user hears about it once, when it stops working, not on every call afterwards
      if (wasUsable) await this.deps.alert?.(connector, error.message).catch(() => {});
      return;
    }
    const telling =
      during === 'listing'
        ? ['network', 'unavailable', 'not_found', 'invalid', 'forbidden', 'unknown']
        : ['network', 'unavailable', 'not_found'];
    if (telling.includes(error.kind)) {
      await this.deps.store.update(connector.id, {
        status: connector.status === 'disabled' ? 'disabled' : 'error',
        lastError: error.message,
        lastErrorKind: error.kind,
      });
    }
  }

  // ── Tools ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * Reads the server's tools and compares them with what the user approved: new tools and changed ones are
   * off until the user looks at them.
   */
  async refresh(id: string, signal?: AbortSignal): Promise<RefreshSummary> {
    const connector = await this.mustGet(id);
    if (connector.status === 'disabled') throw new AppError('invalid', `${connector.name} is turned off.`);
    let listed: ListedTool[];
    let info: SessionInfo | null = null;
    try {
      if (needsCompanion(connector)) {
        listed = await this.companion().listTools(connector, { signal, timeoutMs: clampTimeout(connector.timeoutMs) });
      } else {
        const result = await withRetry(
          () =>
            this.guarded(connector, () =>
              this.session(connector, signal, client =>
                listAllTools(client, { timeoutMs: clampTimeout(connector.timeoutMs), signal }),
              ),
            ),
          this.retryPolicy(signal),
        );
        listed = result.value;
        info = result.info;
      }
    } catch (thrown) {
      const error = toAppError(thrown);
      await this.recordFailure(connector, error, 'listing');
      throw error;
    }
    return this.storeListing(connector, listed, info);
  }

  private async storeListing(
    connector: ConnectorRecord,
    listed: ListedTool[],
    info: SessionInfo | null,
  ): Promise<RefreshSummary> {
    const now = this.now();
    const result = await this.deps.store.applyListing(connector.id, await hashTools(listed), now, {
      status: 'connected',
      lastError: null,
      lastErrorKind: null,
      toolsCheckedAt: now,
      ...(info ? { transport: info.transport, serverInfo: info.serverInfo } : {}),
    });
    return { tools: listed.length, added: result.added, changed: result.changed, removed: result.removed };
  }

  /**
   * The user's choice for one tool, for the tool exactly as they saw it (its hash): a tool that changed
   * meanwhile is refused, so an approval never covers a version the user did not see.
   */
  async setToolPolicy(id: string, tool: string, hash: string, policy: ToolPolicy): Promise<void> {
    const connector = await this.mustGet(id);
    const fingerprint = await this.deps.store.fingerprint(id, tool);
    if (!fingerprint || fingerprint.missing) {
      throw new AppError('not_found', `${connector.name} no longer offers ${tool}.`);
    }
    const approved = await this.deps.store.approveTools(id, [{ tool, hash, policy }]);
    if (!approved.length) {
      throw new AppError('invalid', `${tool} changed while you were looking at it. Look at it again.`);
    }
  }

  /** Approves several tools at once, each as the user saw it, with one policy ("ask first", or off). */
  async reviewTools(
    id: string,
    items: { tool: string; hash: string }[],
    policy: Extract<ToolPolicy, 'approve' | 'off'>,
  ): Promise<number> {
    await this.mustGet(id);
    return (
      await this.deps.store.approveTools(
        id,
        items.map(item => ({ ...item, policy })),
      )
    ).length;
  }

  /** The connectors a chat or routine may use: bound to its workspace, on, and the agent's own if it is one. */
  async usableConnectors(scope: CallScope): Promise<ConnectorRecord[]> {
    let allowed: Set<string> | null = null;
    if (scope.agentId) {
      const agent = await this.deps.store.agent(scope.agentId);
      allowed = new Set(agent?.connectors ?? []);
    }
    return (await this.deps.store.list()).filter(
      connector =>
        connector.status !== 'disabled' &&
        connectorBoundTo(connector, scope.workspaceId) &&
        (!allowed || allowed.has(connector.id)),
    );
  }

  /** Every tool the scope may call now, with its policy. */
  async usableTools(scope: CallScope): Promise<{ tools: UsableTool[]; needSignIn: ConnectorRecord[] }> {
    const tools: UsableTool[] = [];
    const needSignIn: ConnectorRecord[] = [];
    for (const connector of await this.usableConnectors(scope)) {
      if (connector.status === 'needs_auth') {
        needSignIn.push(connector);
        continue;
      }
      for (const fingerprint of await this.deps.store.fingerprints(connector.id)) {
        const policy = effectiveToolPolicy(connector, fingerprint);
        if (policy !== 'off') tools.push({ connector, fingerprint, policy });
      }
    }
    tools.sort(
      (a, b) =>
        a.connector.name.localeCompare(b.connector.name) || a.fingerprint.tool.localeCompare(b.fingerprint.tool),
    );
    return { tools, needSignIn };
  }

  /**
   * Checks a call before anything is sent: the connector is the scope's, the tool is approved as it is and on,
   * and the arguments fit its schema. A refusal is a sentence for the agent.
   */
  async prepare(
    scope: CallScope,
    connectorKey: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<Preparation> {
    const usable = await this.usableConnectors(scope);
    const key = lower(connectorKey);
    const connector =
      usable.find(item => item.id === connectorKey.trim()) ?? usable.find(item => lower(item.name) === key);
    if (!connector) {
      if (!scope.workspaceId) {
        return {
          refused:
            'This chat is in no workspace, and connectors are bound to workspaces: the user can move the chat to a workspace that has connectors.',
        };
      }
      const names = usable.map(item => `"${item.name}"`).join(', ');
      return {
        refused: names
          ? `There is no connector "${connectorKey}" for this chat. Its connectors: ${names}.`
          : 'No connector is set up for this chat: the user adds them in Connectors and picks the workspaces that may use each.',
      };
    }
    const fingerprints = await this.deps.store.fingerprints(connector.id);
    const fingerprint =
      fingerprints.find(item => item.tool === toolName.trim()) ??
      fingerprints.find(item => lower(item.tool) === lower(toolName));
    if (!fingerprint) {
      const names = fingerprints
        .filter(item => effectiveToolPolicy(connector, item) !== 'off')
        .map(item => item.tool)
        .slice(0, 30)
        .join(', ');
      return {
        refused: `${connector.name} has no tool "${toolName}".${names ? ` Its tools you may use: ${names}.` : ''}`,
      };
    }
    const tool = fingerprint.tool;
    switch (connectorToolState(fingerprint)) {
      case 'new':
        return {
          refused: `${tool} on ${connector.name} is new: it stays off until the user turns it on in Connectors.`,
        };
      case 'changed':
        return {
          refused: `${tool} on ${connector.name} changed since the user approved it: it stays off until they look at it again in Connectors.`,
        };
      case 'missing':
        return { refused: `${connector.name} no longer offers ${tool}.` };
      default:
        break;
    }
    if (connector.status === 'needs_auth') {
      return { refused: `${connector.name} needs the user to sign in again in Connectors.` };
    }
    const policy = effectiveToolPolicy(connector, fingerprint);
    if (policy === 'off') return { refused: `The user turned off ${tool} on ${connector.name}.` };
    const check = checkArgs(fingerprint.inputSchema, args);
    if (!check.ok) {
      return { refused: `The arguments do not fit ${tool}: ${check.errors.join('; ')}. Fix them and call it again.` };
    }
    return { connector, fingerprint, policy, args };
  }

  /**
   * Calls a prepared tool and returns its answer as text, cut to `maxChars`. The caller has already done what
   * the policy asks (the user's click for a tool that asks first). Reads retry; writes run once.
   *
   * @throws AppError — a write cut off mid-call ('timeout', 'network') may or may not have happened
   */
  async invoke(
    prepared: PreparedCall,
    options: { signal?: AbortSignal; retry: boolean; maxChars: number },
  ): Promise<FormattedResult> {
    const { connector, fingerprint, args } = prepared;
    const timeoutMs = clampTimeout(connector.timeoutMs);
    const once = async (): Promise<unknown> => {
      try {
        if (needsCompanion(connector)) {
          return await this.companion().callTool(connector, fingerprint.tool, args, {
            signal: options.signal,
            timeoutMs,
          });
        }
        const { value } = await this.guarded(connector, () =>
          this.session(connector, options.signal, async client => {
            await this.verifyCurrent(client, connector, fingerprint, timeoutMs, options.signal);
            return client.callTool({ name: fingerprint.tool, arguments: args }, undefined, {
              timeout: timeoutMs,
              signal: options.signal,
              resetTimeoutOnProgress: true,
              maxTotalTimeout: Math.max(timeoutMs, MAX_TIMEOUT_MS),
            });
          }),
        );
        return value;
      } catch (thrown) {
        const error = toAppError(thrown);
        // A slow tool is slow again the next time: a timeout is not tried again
        if (error.kind === 'timeout') {
          throw new AppError(
            'timeout',
            `${fingerprint.tool} on ${connector.name} did not answer within ${Math.round(timeoutMs / 1000)} s.`,
            {
              cause: thrown,
              retryable: false,
            },
          );
        }
        throw error;
      }
    };
    let result: unknown;
    try {
      result = options.retry ? await withRetry(once, this.retryPolicy(options.signal)) : await once();
    } catch (thrown) {
      const error = toAppError(thrown);
      await this.recordFailure(connector, error, 'call');
      throw error;
    }
    if (connector.status === 'error') {
      await this.deps.store.update(connector.id, { status: 'connected', lastError: null, lastErrorKind: null });
    }
    return formatToolResult(result, options.maxChars);
  }

  /**
   * Before a call, the tool's definition is read again when the last reading is old: a tool that changed since
   * the user approved it is not called.
   */
  private async verifyCurrent(
    client: Client,
    connector: ConnectorRecord,
    fingerprint: ToolFingerprint,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const fresh = await this.deps.store.get(connector.id);
    const checkedAt = fresh?.toolsCheckedAt ?? connector.toolsCheckedAt ?? 0;
    if (this.now() - checkedAt <= RECHECK_MS) return;
    const listed = await listAllTools(client, { timeoutMs, signal });
    await this.storeListing(fresh ?? connector, listed, null);
    const now = await this.deps.store.fingerprint(connector.id, fingerprint.tool);
    if (!now || now.missing || !now.approved || now.hash !== fingerprint.hash) {
      throw new AppError(
        'forbidden',
        `${fingerprint.tool} on ${connector.name} changed since the user approved it, so it was not called. It stays off until they look at it again in Connectors.`,
        { retryable: false },
      );
    }
  }

  private companion() {
    const bridge = companionToolBridge();
    if (!bridge) {
      throw new AppError('unavailable', 'This connector runs on your Mac through Ava Brain, which is not set up yet.', {
        retryable: false,
      });
    }
    return bridge;
  }
}

function urlProblem(problem: 'invalid' | 'insecure' | 'credentials'): string {
  switch (problem) {
    case 'insecure':
      return 'Use an https:// address (plain http:// only for this computer).';
    case 'credentials':
      return 'Leave the user name and password out of the address; add a token instead.';
    default:
      return 'That is not a web address.';
  }
}

function lastChars(secret: string): string | null {
  const trimmed = secret.trim();
  return trimmed.length >= 12 ? trimmed.slice(-4) : null;
}
