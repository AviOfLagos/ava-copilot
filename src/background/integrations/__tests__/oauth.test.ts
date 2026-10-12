import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@extension/shared';
import { clientRef, oauthRef } from '../credentials';
import { OAuthManager, PENDING_TTL_MS } from '../oauth';
import type { StoredTokens } from '../oauth';
import { connectorRecord, json, memorySession, memoryVault, routeFetch } from './fakes';

const SERVER = 'https://mcp.example/mcp';
const AS = 'https://auth.example';
const REDIRECT = 'https://fckijnclcihjnokahdnbogpbeiimfdio.chromiumapp.org/';

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** An MCP server that wants a token, and its authorization server (with registration and PKCE). */
function fakeAuthServer() {
  const issued = { codes: new Map<string, { challenge: string }>(), refreshes: 0, registrations: 0 };
  const seen: { method: string; url: string; body: string }[] = [];
  let pendingChallenge = '';
  const fetch = routeFetch(
    {
      [`POST ${SERVER}`]: () =>
        json({ error: 'unauthorized' }, 401, {
          'www-authenticate': `Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp", scope="read write"`,
        }),
      'GET https://mcp.example/.well-known/oauth-protected-resource/mcp': () =>
        json({ resource: SERVER, authorization_servers: [AS], scopes_supported: ['read', 'write', 'admin'] }),
      [`GET ${AS}/.well-known/oauth-authorization-server`]: () =>
        json({
          issuer: AS,
          authorization_endpoint: `${AS}/authorize`,
          token_endpoint: `${AS}/token`,
          registration_endpoint: `${AS}/register`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          authorization_response_iss_parameter_supported: true,
        }),
      [`POST ${AS}/register`]: async request => {
        issued.registrations += 1;
        const body = (await request.json()) as Record<string, unknown>;
        return json({ ...body, client_id: 'client-123', client_id_issued_at: 1 }, 201);
      },
      [`POST ${AS}/token`]: async request => {
        const form = new URLSearchParams(await request.text());
        if (form.get('grant_type') === 'authorization_code') {
          const code = issued.codes.get(form.get('code') ?? '');
          if (!code || (await s256(form.get('code_verifier') ?? '')) !== code.challenge) {
            return json({ error: 'invalid_grant' }, 400);
          }
          return json({ access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: 3600 });
        }
        if (form.get('grant_type') === 'refresh_token') {
          issued.refreshes += 1;
          if (form.get('refresh_token') === 'dead') return json({ error: 'invalid_grant' }, 400);
          await new Promise(resolve => setTimeout(resolve, 20));
          return json({
            access_token: `access-r${issued.refreshes}`,
            refresh_token: `refresh-r${issued.refreshes}`,
            token_type: 'Bearer',
            expires_in: 3600,
          });
        }
        return json({ error: 'unsupported_grant_type' }, 400);
      },
    },
    seen,
  );
  // What the user's browser does at the sign-in page: the server remembers the challenge and sends back a code
  const authorize = (authorizationUrl: string, overrides: Record<string, string> = {}) => {
    const url = new URL(authorizationUrl);
    pendingChallenge = url.searchParams.get('code_challenge') ?? '';
    issued.codes.set('code-1', { challenge: pendingChallenge });
    const back = new URL(url.searchParams.get('redirect_uri') ?? REDIRECT);
    back.searchParams.set('code', 'code-1');
    back.searchParams.set('state', url.searchParams.get('state') ?? '');
    back.searchParams.set('iss', AS);
    for (const [key, value] of Object.entries(overrides)) back.searchParams.set(key, value);
    return back.href;
  };
  return { fetch, issued, seen, authorize };
}

let vault: ReturnType<typeof memoryVault>;
let session: ReturnType<typeof memorySession>;
let server: ReturnType<typeof fakeAuthServer>;
let now: number;
const connector = connectorRecord({
  authKind: 'oauth',
  url: SERVER,
  status: 'needs_auth',
  oauth: { clientId: null, hasClientSecret: false, scope: null },
});

function manager() {
  return new OAuthManager({
    fetch: server.fetch,
    vault,
    session,
    redirectUri: () => REDIRECT,
    connector: async id => (id === connector.id ? connector : undefined),
    now: () => now,
  });
}

beforeEach(() => {
  vault = memoryVault();
  session = memorySession();
  server = fakeAuthServer();
  now = 1_000_000;
});

describe('signing in with OAuth 2.1 and PKCE', () => {
  it('registers itself, asks for an S256 code with a state and the resource, and keeps the verifier aside', async () => {
    const started = await manager().begin(connector);
    const url = new URL(started.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${AS}/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')?.length).toBeGreaterThanOrEqual(40);
    expect(url.searchParams.get('resource')).toBe(SERVER);
    // The scope the server's challenge asked for, not everything it supports
    expect(url.searchParams.get('scope')).toBe('read write');
    // Registered as a public client for the extension's redirect, kept in the vault
    const registration = JSON.parse(server.seen.find(request => request.url.endsWith('/register'))!.body);
    expect(registration).toMatchObject({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
    expect(JSON.parse(vault.data.get(clientRef('c1'))!)).toMatchObject({ client_id: 'client-123' });
    // The verifier is in session storage, never in the address
    const pending = Object.values(session.data['connector-oauth-pending'] as Record<string, { codeVerifier: string }>);
    expect(pending).toHaveLength(1);
    expect(started.authorizationUrl).not.toContain(pending[0].codeVerifier);
    expect(await s256(pending[0].codeVerifier)).toBe(url.searchParams.get('code_challenge'));
  });

  it('finishes with the code from a mocked launchWebAuthFlow, proving the verifier, and stores the tokens', async () => {
    const oauth = manager();
    const launchWebAuthFlow = vi.fn(async (details: { url: string; interactive: boolean }) =>
      server.authorize(details.url),
    );
    const started = await oauth.begin(connector);
    const redirect = await launchWebAuthFlow({ url: started.authorizationUrl, interactive: true });
    const finished = await oauth.finish(redirect);
    expect(launchWebAuthFlow).toHaveBeenCalledOnce();
    expect(finished.connectorId).toBe('c1');
    const stored = JSON.parse(vault.data.get(oauthRef('c1'))!) as StoredTokens;
    expect(stored).toMatchObject({ access_token: 'access-1', refresh_token: 'refresh-1', expires_at: now + 3_600_000 });
    // A second registration is not needed for the next sign-in
    await oauth.begin(connector);
    expect(server.issued.registrations).toBe(1);
  });

  it('refuses an answer with an unknown or reused state, from another issuer, or too late', async () => {
    const oauth = manager();
    const started = await oauth.begin(connector);
    const redirect = server.authorize(started.authorizationUrl);
    await expect(oauth.finish(redirect.replace(/state=[^&]+/, 'state=forged'))).rejects.toMatchObject({
      kind: 'invalid',
    });
    await oauth.finish(redirect);
    await expect(oauth.finish(redirect)).rejects.toMatchObject({ kind: 'invalid' });

    const second = await oauth.begin(connector);
    await expect(
      oauth.finish(server.authorize(second.authorizationUrl, { iss: 'https://evil.example' })),
    ).rejects.toMatchObject({
      kind: 'auth',
    });

    const third = await oauth.begin(connector);
    now += PENDING_TTL_MS + 1;
    await expect(oauth.finish(server.authorize(third.authorizationUrl))).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('refuses an answer sent anywhere but the extension’s own redirect', async () => {
    const oauth = manager();
    const started = await oauth.begin(connector);
    const redirect = server.authorize(started.authorizationUrl).replace(REDIRECT, 'https://evil.example/');
    await expect(oauth.finish(redirect)).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('says so when the user cancels on the service’s page', async () => {
    const oauth = manager();
    const started = await oauth.begin(connector);
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    await expect(oauth.finish(`${REDIRECT}?error=access_denied&state=${state}`)).rejects.toMatchObject({
      kind: 'cancelled',
    });
  });
});

describe('where a sign-in may go', () => {
  it('refuses an authorization server or endpoint that is not https, before sending it anything', async () => {
    const seen: { method: string; url: string; body: string }[] = [];
    const evil = routeFetch(
      {
        [`POST ${SERVER}`]: () =>
          json({}, 401, {
            'www-authenticate': `Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp"`,
          }),
        'GET https://mcp.example/.well-known/oauth-protected-resource/mcp': () =>
          json({ resource: SERVER, authorization_servers: ['http://10.0.0.5'] }),
      },
      seen,
    );
    const oauth = new OAuthManager({
      fetch: evil,
      vault,
      session,
      redirectUri: () => REDIRECT,
      connector: async () => connector,
    });
    await expect(oauth.begin(connector)).rejects.toMatchObject({ kind: 'invalid' });
    expect(seen.some(request => request.url.startsWith('http://10.0.0.5'))).toBe(false);

    const plainToken = routeFetch({
      [`POST ${SERVER}`]: () => json({}, 401, { 'www-authenticate': 'Bearer' }),
      'GET https://mcp.example/.well-known/oauth-authorization-server': () =>
        json({
          issuer: 'https://mcp.example',
          authorization_endpoint: 'https://mcp.example/authorize',
          token_endpoint: 'http://tokens.example/token',
          response_types_supported: ['code'],
        }),
    });
    const second = new OAuthManager({
      fetch: plainToken,
      vault,
      session,
      redirectUri: () => REDIRECT,
      connector: async () => connector,
    });
    await expect(second.begin(connector)).rejects.toMatchObject({ kind: 'invalid' });
  });
});

describe('renewing tokens', () => {
  const storeTokens = async (changes: Partial<StoredTokens> = {}) => {
    await vault.put(clientRef('c1'), JSON.stringify({ client_id: 'client-123' }));
    await vault.put(
      oauthRef('c1'),
      JSON.stringify({
        access_token: 'access-old',
        refresh_token: 'refresh-old',
        expires_at: now - 1000,
        saved_at: now - 10_000,
        authorization_server: AS,
        metadata: null,
        resource: SERVER,
        ...changes,
      }),
    );
  };

  it('renews an expiring token once however many calls wait for it', async () => {
    await storeTokens();
    const oauth = manager();
    const tokens = await Promise.all([
      oauth.accessToken(connector),
      oauth.accessToken(connector),
      oauth.renew(connector),
    ]);
    expect(server.issued.refreshes).toBe(1);
    expect(tokens[0]).toBe('access-r1');
    expect(tokens[1]).toBe('access-r1');
    expect(tokens[2].access_token).toBe('access-r1');
    // The rotated refresh token replaced the old one
    expect(JSON.parse(vault.data.get(oauthRef('c1'))!).refresh_token).toBe('refresh-r1');
  });

  it('uses a token another call already renewed instead of renewing again', async () => {
    await storeTokens({ access_token: 'access-new', expires_at: now + 3_600_000 });
    expect(await manager().renewAfterRefusal(connector, 'access-old')).toBe('access-new');
    expect(server.issued.refreshes).toBe(0);
  });

  it('asks the user to sign in again when the refresh token is dead or missing', async () => {
    await storeTokens({ refresh_token: 'dead' });
    await expect(manager().accessToken(connector)).rejects.toSatisfy(
      (error: unknown) => AppError.isInstance(error) && error.kind === 'auth',
    );
    await storeTokens({ refresh_token: undefined });
    await expect(manager().accessToken(connector)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('uses the user’s own client ID and secret when the service does not register apps', async () => {
    const own = connectorRecord({
      ...connector,
      oauth: { clientId: 'my-slack-app', hasClientSecret: true, scope: 'chat:write' },
    });
    await vault.put(clientRef('c1'), JSON.stringify({ client_id: 'my-slack-app', client_secret: 'shh-secret-value' }));
    const oauth = new OAuthManager({
      fetch: server.fetch,
      vault,
      session,
      redirectUri: () => REDIRECT,
      connector: async () => own,
      now: () => now,
    });
    const started = await oauth.begin(own);
    const url = new URL(started.authorizationUrl);
    expect(url.searchParams.get('client_id')).toBe('my-slack-app');
    expect(url.searchParams.get('scope')).toBe('chat:write');
    expect(server.issued.registrations).toBe(0);
  });
});
