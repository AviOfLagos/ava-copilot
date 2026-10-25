import { AppError } from '@extension/shared';
import { checkConnectorUrl } from '@extension/storage';
import type { ConnectorRecord } from '@extension/storage';
import { clientRef, oauthRef, parseJson } from './credentials';
import type { SecretVaultLike } from './credentials';
import { connectorError } from './errors';
import {
  checkResourceAllowed,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  LATEST_PROTOCOL_VERSION,
  refreshAuthorization,
  registerClient,
  resourceUrlFromServerUrl,
  startAuthorization,
} from './sdk';
import type { AuthorizationServerMetadata, FetchLike, OAuthClientInformationMixed, OAuthTokens } from './sdk';

/**
 * Signing in to a connector with OAuth 2.1 and PKCE. The background prepares the sign-in (discovery, client
 * registration when the server offers it, a PKCE verifier and a state) and keeps it in `storage.session`; the
 * panel opens the service's page with `chrome.identity.launchWebAuthFlow` and hands back where it was sent;
 * the background checks the state and trades the code for tokens, which go to the vault. A sign-in therefore
 * survives the background being stopped while the user types their password.
 *
 * Tokens are renewed shortly before they run out, one renewal per connector at a time however many calls wait.
 */

// A sign-in not finished within this time is forgotten
export const PENDING_TTL_MS = 15 * 60_000;
// Renew a token this long before it runs out
const RENEW_MARGIN_MS = 60_000;
const PENDING_KEY = 'connector-oauth-pending';

export interface SessionAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface OAuthDeps {
  fetch: FetchLike;
  vault: SecretVaultLike;
  session: SessionAreaLike;
  // Where the service sends the user back: https://<extension id>.chromiumapp.org/
  redirectUri: () => string;
  connector: (id: string) => Promise<ConnectorRecord | undefined>;
  now?: () => number;
}

interface PendingSignIn {
  state: string;
  connectorId: string;
  codeVerifier: string;
  redirectUri: string;
  authorizationServerUrl: string;
  metadata: AuthorizationServerMetadata | null;
  resource: string | null;
  createdAt: number;
}

/** What the vault keeps for a signed-in connector: its tokens and where to renew them. */
export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_at: number | null;
  saved_at: number;
  authorization_server: string;
  metadata: AuthorizationServerMetadata | null;
  resource: string | null;
}

// A client as kept in the vault, with the redirect and the sign-in server it was registered for
type StoredClient = OAuthClientInformationMixed & { redirect_uris?: string[]; registered_for?: string | null };

const CLIENT_NAME = 'Ava Copilot';

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Sign-in addresses must be https (plain http only on this computer), like the connector's own. */
function mustBeSafe(address: string, name: string): void {
  if ('error' in checkConnectorUrl(address)) {
    throw new AppError('invalid', `${name} names a sign-in address that is not safe to use (${address.slice(0, 80)}).`);
  }
}

// Errors from the token endpoint that mean the grant or the client is dead: only signing in again helps
const DEAD_GRANT = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

function oauthErrorCode(error: unknown): string | null {
  const code = (error as { errorCode?: unknown } | null)?.errorCode;
  return typeof code === 'string' ? code : null;
}

export class OAuthManager {
  private readonly renewing = new Map<string, Promise<StoredTokens>>();

  constructor(private readonly deps: OAuthDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // ── Sign-in ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Prepares a sign-in and returns the address of the service's sign-in page.
   *
   * @throws AppError when the server does not say how to sign in, or needs a client ID the user has not given
   */
  async begin(
    connector: ConnectorRecord,
  ): Promise<{ authorizationUrl: string; authorizationServerUrl: string; issuer: string | null }> {
    if (!connector.url) throw new AppError('invalid', 'This connector has no address.');
    const name = connector.name;
    const redirectUri = this.deps.redirectUri();
    try {
      // A server that wants a token says where its sign-in is described, and which scopes it needs
      const challenge = await this.challenge(connector.url);
      const info = await this.discover(connector.url, challenge.resourceMetadataUrl);
      const metadata = info.authorizationServerMetadata ?? null;
      if (!metadata) {
        throw new AppError(
          'invalid',
          `${name} does not say how to sign in. Use a token instead, or check the address.`,
        );
      }
      // The sign-in page, the token and registration endpoints get the code, the verifier and any client secret
      for (const endpoint of [
        metadata.authorization_endpoint,
        metadata.token_endpoint,
        metadata.registration_endpoint,
      ]) {
        if (endpoint !== undefined) mustBeSafe(String(endpoint), name);
      }
      const resource = this.resourceFor(connector.url, info.resourceMetadata?.resource);
      const scope =
        connector.oauth?.scope ??
        challenge.scope ??
        (info.resourceMetadata?.scopes_supported?.length
          ? info.resourceMetadata.scopes_supported.join(' ')
          : undefined);
      const clientInformation = await this.clientFor(
        connector,
        info.authorizationServerUrl,
        metadata,
        redirectUri,
        scope,
      );

      const state = randomState();
      const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, {
        metadata,
        clientInformation,
        redirectUrl: redirectUri,
        scope,
        state,
        resource: resource ?? undefined,
      });
      for (const [key, value] of Object.entries(connector.oauth?.authParams ?? {})) {
        authorizationUrl.searchParams.set(key, value);
      }
      await this.savePending({
        state,
        connectorId: connector.id,
        codeVerifier,
        redirectUri,
        authorizationServerUrl: info.authorizationServerUrl,
        metadata,
        resource: resource?.href ?? null,
        createdAt: this.now(),
      });
      return {
        authorizationUrl: authorizationUrl.href,
        authorizationServerUrl: info.authorizationServerUrl,
        issuer: typeof metadata.issuer === 'string' ? metadata.issuer : null,
      };
    } catch (error) {
      throw connectorError(error, name);
    }
  }

  /**
   * Finishes a sign-in from the address the service sent the user back to: the state must be one this
   * background started (and not too long ago), the issuer the one asked, and the code is traded with the
   * PKCE verifier only this background knows.
   *
   * @returns The connector signed in, with its tokens stored in the vault
   */
  async finish(redirectUrl: string): Promise<{ connectorId: string; tokens: StoredTokens }> {
    let url: URL;
    try {
      url = new URL(redirectUrl);
    } catch {
      throw new AppError('invalid', 'The sign-in did not come back where expected.');
    }
    const expected = new URL(this.deps.redirectUri());
    if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
      throw new AppError('invalid', 'The sign-in did not come back where expected.');
    }
    const state = url.searchParams.get('state') ?? '';
    const pending = state ? await this.takePending(state) : null;
    if (!pending || this.now() - pending.createdAt > PENDING_TTL_MS) {
      throw new AppError('invalid', 'This sign-in expired or was not started here. Start it again.');
    }
    const connector = await this.deps.connector(pending.connectorId);
    if (!connector) throw new AppError('not_found', 'That connector was removed.');

    const refused = url.searchParams.get('error');
    if (refused) {
      throw refused === 'access_denied'
        ? new AppError('cancelled', 'The sign-in was cancelled.')
        : new AppError('auth', `${connector.name} refused the sign-in (${refused.slice(0, 40)}).`);
    }
    // RFC 9207: the answer names the server that issued it, so a sign-in cannot be answered by another one
    const issuer = url.searchParams.get('iss');
    const expectedIssuer = typeof pending.metadata?.issuer === 'string' ? pending.metadata.issuer : null;
    const issuerRequired =
      (pending.metadata as Record<string, unknown> | null)?.authorization_response_iss_parameter_supported === true;
    if ((issuer && expectedIssuer && issuer !== expectedIssuer) || (issuerRequired && !issuer)) {
      throw new AppError('auth', `The sign-in answer did not come from ${connector.name}'s sign-in server.`);
    }
    const code = url.searchParams.get('code');
    if (!code) throw new AppError('auth', `${connector.name} sent no sign-in code back.`);

    try {
      const tokens = await exchangeAuthorization(pending.authorizationServerUrl, {
        metadata: pending.metadata ?? undefined,
        clientInformation: await this.storedClient(connector),
        authorizationCode: code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
        resource: pending.resource ?? undefined,
        fetchFn: this.deps.fetch,
      });
      const stored = this.toStored(tokens, pending.authorizationServerUrl, pending.metadata, pending.resource, null);
      await this.deps.vault.put(oauthRef(connector.id), JSON.stringify(stored));
      return { connectorId: connector.id, tokens: stored };
    } catch (error) {
      if (oauthErrorCode(error)) {
        throw new AppError('auth', `${connector.name} refused the sign-in. Try again.`, { cause: error });
      }
      throw connectorError(error, connector.name);
    }
  }

  /** Forgets the tokens; the client registration stays for the next sign-in. */
  async signOut(connectorId: string): Promise<void> {
    await this.deps.vault.delete(oauthRef(connectorId));
  }

  // ── Tokens ────────────────────────────────────────────────────────────────────────────────────

  /** The stored tokens, or null when the connector is not signed in. */
  async tokens(connectorId: string): Promise<StoredTokens | null> {
    return parseJson<StoredTokens>(await this.deps.vault.get(oauthRef(connectorId)));
  }

  /**
   * An access token to call with, renewed first when it is about to run out.
   *
   * @throws AppError 'auth' when there is none, or it cannot be renewed (the user must sign in again)
   */
  async accessToken(connector: ConnectorRecord): Promise<string> {
    const stored = await this.tokens(connector.id);
    if (!stored?.access_token) throw new AppError('auth', `Sign in to ${connector.name} first.`);
    if (stored.expires_at !== null && stored.expires_at - RENEW_MARGIN_MS <= this.now()) {
      return (await this.renew(connector)).access_token;
    }
    return stored.access_token;
  }

  /**
   * The server refused `usedToken`: renews it, unless another call already did (then that token is returned).
   */
  async renewAfterRefusal(connector: ConnectorRecord, usedToken: string): Promise<string> {
    const stored = await this.tokens(connector.id);
    if (stored?.access_token && stored.access_token !== usedToken) return stored.access_token;
    return (await this.renew(connector)).access_token;
  }

  /** Renews the tokens once at a time per connector: every caller waiting meanwhile gets the same result. */
  renew(connector: ConnectorRecord): Promise<StoredTokens> {
    let running = this.renewing.get(connector.id);
    if (!running) {
      running = this.renewNow(connector).finally(() => this.renewing.delete(connector.id));
      this.renewing.set(connector.id, running);
    }
    return running;
  }

  private async renewNow(connector: ConnectorRecord): Promise<StoredTokens> {
    // Read again: the tokens may have been rotated since the caller looked
    const stored = await this.tokens(connector.id);
    if (!stored?.refresh_token) {
      throw new AppError('auth', `Sign in to ${connector.name} again.`);
    }
    let tokens: OAuthTokens;
    try {
      tokens = await refreshAuthorization(stored.authorization_server, {
        metadata: stored.metadata ?? undefined,
        clientInformation: await this.storedClient(connector),
        refreshToken: stored.refresh_token,
        resource: stored.resource ?? undefined,
        fetchFn: this.deps.fetch,
      });
    } catch (error) {
      const code = oauthErrorCode(error);
      if (code && DEAD_GRANT.has(code)) {
        throw new AppError('auth', `Sign in to ${connector.name} again.`, { cause: error });
      }
      throw connectorError(error, connector.name);
    }
    // A server that rotates refresh tokens sends a new one; one that does not keeps the old one valid
    const next = this.toStored(
      tokens,
      stored.authorization_server,
      stored.metadata,
      stored.resource,
      stored.refresh_token,
    );
    await this.deps.vault.put(oauthRef(connector.id), JSON.stringify(next));
    return next;
  }

  private toStored(
    tokens: OAuthTokens,
    authorizationServer: string,
    metadata: AuthorizationServerMetadata | null,
    resource: string | null,
    previousRefresh: string | undefined | null,
  ): StoredTokens {
    const now = this.now();
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? previousRefresh ?? undefined,
      token_type: tokens.token_type,
      scope: tokens.scope,
      expires_at: typeof tokens.expires_in === 'number' ? now + tokens.expires_in * 1000 : null,
      saved_at: now,
      authorization_server: authorizationServer,
      metadata,
      resource,
    };
  }

  // ── Clients ───────────────────────────────────────────────────────────────────────────────────

  /** The client to sign in as: the user's own, one registered before for this address, or a new registration. */
  private async clientFor(
    connector: ConnectorRecord,
    authorizationServerUrl: string,
    metadata: AuthorizationServerMetadata,
    redirectUri: string,
    scope: string | undefined,
  ): Promise<OAuthClientInformationMixed> {
    if (connector.oauth?.clientId) return this.storedClient(connector);
    const issuer = typeof metadata.issuer === 'string' ? metadata.issuer : null;
    const registered = parseJson<StoredClient>(await this.deps.vault.get(clientRef(connector.id)));
    if (
      registered?.client_id &&
      registered.redirect_uris?.includes(redirectUri) &&
      registered.registered_for === issuer
    ) {
      return registered;
    }
    if (!metadata.registration_endpoint) {
      throw new AppError(
        'invalid',
        `${connector.name} does not register apps by itself: add a client ID from its developer settings in Connectors.`,
      );
    }
    const client = await registerClient(authorizationServerUrl, {
      metadata,
      clientMetadata: {
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      scope,
      fetchFn: this.deps.fetch,
    });
    const kept: StoredClient = { ...client, redirect_uris: [redirectUri], registered_for: issuer };
    await this.deps.vault.put(clientRef(connector.id), JSON.stringify(kept));
    return kept;
  }

  /** The client the connector signs in as, from the vault (the user's own ID and secret, or a registration). */
  private async storedClient(connector: ConnectorRecord): Promise<OAuthClientInformationMixed> {
    const stored = parseJson<StoredClient>(await this.deps.vault.get(clientRef(connector.id)));
    const clientId = connector.oauth?.clientId ?? stored?.client_id;
    if (!clientId) throw new AppError('auth', `Sign in to ${connector.name} again.`);
    // The user's own client: its ID from the record, its secret (if any) from the vault
    if (connector.oauth?.clientId) {
      return stored?.client_secret
        ? { client_id: clientId, client_secret: stored.client_secret }
        : { client_id: clientId };
    }
    return stored as OAuthClientInformationMixed;
  }

  // ── Discovery ─────────────────────────────────────────────────────────────────────────────────

  /**
   * The server's resource metadata (RFC 9728) and its authorization server's (RFC 8414 / OpenID). The server
   * names the authorization server; it is only asked when its address is https (or this computer), so a server
   * cannot point the sign-in at a plain-http or odd address.
   */
  private async discover(serverUrl: string, resourceMetadataUrl: URL | undefined) {
    let resourceMetadata: Awaited<ReturnType<typeof discoverOAuthProtectedResourceMetadata>> | undefined;
    try {
      resourceMetadata = await discoverOAuthProtectedResourceMetadata(
        serverUrl,
        { resourceMetadataUrl },
        this.deps.fetch,
      );
    } catch {
      // No RFC 9728 metadata: the server's own origin is its authorization server, as older servers have it
    }
    const authorizationServerUrl = resourceMetadata?.authorization_servers?.[0] ?? new URL('/', serverUrl).href;
    mustBeSafe(authorizationServerUrl, new URL(serverUrl).host);
    const authorizationServerMetadata = await discoverAuthorizationServerMetadata(authorizationServerUrl, {
      fetchFn: this.deps.fetch,
    });
    return { authorizationServerUrl, authorizationServerMetadata, resourceMetadata };
  }

  /** Asks the server without a token: a 401 names its resource metadata and the scopes it wants. */
  private async challenge(serverUrl: string): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
    try {
      const response = await this.deps.fetch(serverUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'avi-copilot', version: '1' },
          },
        }),
      });
      await response.body?.cancel().catch(() => {});
      if (response.status !== 401) return {};
      const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
      // Only metadata on the server's own origin is followed
      return {
        resourceMetadataUrl:
          resourceMetadataUrl && resourceMetadataUrl.origin === new URL(serverUrl).origin
            ? resourceMetadataUrl
            : undefined,
        scope,
      };
    } catch {
      return {};
    }
  }

  /** The resource to ask a token for (RFC 8707): the server's own, when it says and it covers this address. */
  private resourceFor(serverUrl: string, advertised: string | undefined): URL | null {
    if (!advertised) return null;
    if (
      !checkResourceAllowed({ requestedResource: resourceUrlFromServerUrl(serverUrl), configuredResource: advertised })
    ) {
      throw new AppError('invalid', 'The server describes another address than its own for sign-in.');
    }
    return new URL(advertised);
  }

  // ── Pending sign-ins ──────────────────────────────────────────────────────────────────────────

  private async pending(): Promise<Record<string, PendingSignIn>> {
    const stored = (await this.deps.session.get(PENDING_KEY))[PENDING_KEY];
    return stored && typeof stored === 'object' ? (stored as Record<string, PendingSignIn>) : {};
  }

  private async savePending(entry: PendingSignIn): Promise<void> {
    const now = this.now();
    // One sign-in per connector at a time, and none older than the time limit
    const kept = Object.fromEntries(
      Object.entries(await this.pending()).filter(
        ([, item]) => item.connectorId !== entry.connectorId && now - item.createdAt <= PENDING_TTL_MS,
      ),
    );
    await this.deps.session.set({ [PENDING_KEY]: { ...kept, [entry.state]: entry } });
  }

  /** The pending sign-in with this state, removed so it is used once. */
  private async takePending(state: string): Promise<PendingSignIn | null> {
    const all = await this.pending();
    const entry = all[state] ?? null;
    if (entry) {
      delete all[state];
      await this.deps.session.set({ [PENDING_KEY]: all });
    }
    return entry;
  }

  /** Drops sign-ins that were never finished. */
  async prunePending(): Promise<void> {
    const now = this.now();
    const all = await this.pending();
    const kept = Object.fromEntries(Object.entries(all).filter(([, item]) => now - item.createdAt <= PENDING_TTL_MS));
    if (Object.keys(kept).length !== Object.keys(all).length) await this.deps.session.set({ [PENDING_KEY]: kept });
  }
}
