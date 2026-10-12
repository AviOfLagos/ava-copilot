import type { ConnectorRecord } from '@extension/storage';
import type { SecretVaultLike } from '../credentials';
import type { SessionAreaLike } from '../oauth';

/** An in-memory vault with the real one's contract (values trimmed, null when missing). */
export function memoryVault(): SecretVaultLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async ref => data.get(ref) ?? null,
    put: async (ref, value) => {
      data.set(ref, value.trim());
    },
    delete: async ref => {
      data.delete(ref);
    },
  };
}

/** chrome.storage.session, in memory. */
export function memorySession(): SessionAreaLike & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async key => (key in data ? { [key]: structuredClone(data[key]) } : {}),
    set: async items => {
      Object.assign(data, structuredClone(items));
    },
  };
}

export function connectorRecord(changes: Partial<ConnectorRecord> = {}): ConnectorRecord {
  return {
    id: 'c1',
    name: 'Fake',
    kind: 'mcp_http',
    url: 'https://mcp.example/mcp',
    authKind: 'none',
    secretRef: null,
    workspaceIds: ['w1'],
    status: 'connected',
    toolPolicy: {},
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    transport: 'auto',
    timeoutMs: 5000,
    ...changes,
  };
}

/** A fetch answering from a table of handlers by method and address. */
export function routeFetch(
  routes: Record<string, (request: Request) => Response | Promise<Response>>,
  seen: { method: string; url: string; body: string }[] = [],
) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const body = request.method === 'GET' ? '' : await request.clone().text();
    const url = new URL(request.url);
    const key = `${request.method} ${url.origin}${url.pathname}`;
    seen.push({ method: request.method, url: request.url, body });
    const handler = routes[key];
    if (!handler) return new Response('not found', { status: 404 });
    return handler(request);
  };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
