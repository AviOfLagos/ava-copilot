/**
 * Where a connector's secrets live in the vault, by name. Only the background reads them; the connector record
 * keeps none of them, only their last characters for the user to recognise.
 */

// A token the user pasted (token sign-in)
export const tokenRef = (connectorId: string) => `conn:${connectorId}:token`;
// OAuth tokens, with where to renew them
export const oauthRef = (connectorId: string) => `conn:${connectorId}:oauth`;
// The OAuth client: one the server registered for us, or the user's own ID and secret
export const clientRef = (connectorId: string) => `conn:${connectorId}:client`;

export const allSecretRefs = (connectorId: string) => [
  tokenRef(connectorId),
  oauthRef(connectorId),
  clientRef(connectorId),
];

export interface SecretVaultLike {
  get(ref: string): Promise<string | null>;
  put(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

/** The header a pasted token travels in: "Authorization: Bearer <token>" unless the user named another header. */
export function tokenHeaders(header: string | null | undefined, token: string): Record<string, string> {
  const name = header?.trim() || 'Authorization';
  if (name.toLowerCase() !== 'authorization') return { [name]: token };
  return { Authorization: /^(bearer|basic|token)\s/i.test(token) ? token : `Bearer ${token}` };
}

/** Header names a user may set: plain tokens, no names that would change how the request travels. */
export function isUsableHeaderName(name: string): boolean {
  return (
    /^[A-Za-z0-9-]{1,64}$/.test(name) &&
    !['host', 'content-length', 'content-type', 'accept', 'cookie', 'origin', 'mcp-session-id'].includes(
      name.toLowerCase(),
    ) &&
    !name.toLowerCase().startsWith('mcp-')
  );
}

export function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
