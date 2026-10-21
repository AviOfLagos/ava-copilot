import type { ConnectorRecord, ProviderConfig } from '@extension/storage';
import { getDefaultProviderConfig } from '@extension/storage/lib/settings/llmProviders';
import { ProviderTypeEnum } from '@extension/storage/lib/settings/types';

/**
 * What a backup may carry, and what a restore may believe.
 *
 * 1. No secret travels inside a snapshot or a file: fields whose names say they hold one (apiKey, token,
 *    accessToken, refreshToken, secret, password, clientSecret, authorization, cookie…, any case, at any depth) are
 *    emptied before a snapshot is written. Keys go only through the Keychain path (./service.ts).
 * 2. A file from disk is not the user's own Nex Brain: anyone could have made it. Restoring one keeps this
 *    browser's security settings (firewall, what asks first, installed skills, approved connector tools), and
 *    unbinds every key from a model provider or connector whose endpoint is not the one it has now (or, when there is
 *    none, the provider's known default), so a crafted file cannot point a saved key at another server.
 */

// Lower-cased, without "-" and "_": a field with one of these names, or ending in one, holds a secret
const SECRET_NAMES = [
  'apikey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'token',
  'clientsecret',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'authorization',
  'cookie',
  'cookies',
  'privatekey',
];
// Values that stand in for no key at all (local servers): kept so their configs still work
const PLACEHOLDERS = new Set(['', 'ollama', 'lm-studio']);

export function isSecretFieldName(name: string): boolean {
  const plain = name.toLowerCase().replace(/[-_]/g, '');
  return SECRET_NAMES.some(secret => plain === secret || plain.endsWith(secret));
}

/**
 * The value with every secret-named field emptied: a string becomes '', an object or array under such a name is
 * removed; numbers and booleans stay (token counts, hasKey). Returns the same value when nothing changed.
 */
export function redactSecrets<T>(value: T): T {
  if (value === null || typeof value !== 'object' || value instanceof Blob || ArrayBuffer.isView(value)) return value;
  if (value instanceof ArrayBuffer || value instanceof Date) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map(item => {
      const next = redactSecrets(item);
      if (next !== item) changed = true;
      return next;
    });
    return (changed ? out : value) as T;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretFieldName(key)) {
      if (typeof inner === 'string') {
        out[key] = PLACEHOLDERS.has(inner) ? inner : '';
        if (out[key] !== inner) changed = true;
        continue;
      }
      if (inner !== null && typeof inner === 'object') {
        changed = true;
        continue;
      }
    }
    const next = redactSecrets(inner);
    if (next !== inner) changed = true;
    out[key] = next;
  }
  return (changed ? out : value) as T;
}

// ── A file from disk ─────────────────────────────────────────────────────────────────────────────

/** Storage keys a file restore leaves as they are on this browser. */
export const FILE_KEEP_STORAGE_KEYS = new Set(['firewall-settings', 'gate-settings', 'skills', 'workflow-settings']);
/** Tables a file restore leaves as they are: which connector tools the user approved, as they were. */
export const FILE_KEEP_TABLES = new Set(['toolFingerprints']);

const endpoint = (url: string | null | undefined) => (url ?? '').trim().replace(/\/+$/, '').toLowerCase();

function providerEndpoint(config: Pick<ProviderConfig, 'type' | 'baseUrl'>): string {
  return `${config.type ?? ''}|${endpoint(config.baseUrl)}`;
}

const BUILT_IN = new Set<string>(Object.values(ProviderTypeEnum));

/**
 * The model providers of a file, each still bound to its key only when its endpoint is the one it has here now, or
 * the provider's known default when this browser has none. Returns the providers whose key was unbound.
 */
export function unbindMovedProviders(incoming: unknown, current: unknown): { value: unknown; unbound: string[] } {
  const providers = (incoming as { providers?: Record<string, ProviderConfig> } | null)?.providers;
  if (!providers || typeof providers !== 'object') return { value: incoming, unbound: [] };
  const here = (current as { providers?: Record<string, ProviderConfig> } | null)?.providers ?? {};
  const unbound: string[] = [];
  const next: Record<string, ProviderConfig> = {};
  for (const [id, config] of Object.entries(providers)) {
    const reference = here[id] ?? (BUILT_IN.has(id) ? getDefaultProviderConfig(id) : undefined);
    const bound = Boolean(config?.keyRef || config?.hasKey);
    if (bound && (!reference || providerEndpoint(reference) !== providerEndpoint(config))) {
      next[id] = {
        ...config,
        apiKey: PLACEHOLDERS.has(config.apiKey ?? '') ? (config.apiKey ?? '') : '',
        hasKey: false,
      };
      delete next[id].keyRef;
      delete next[id].keyLast4;
      unbound.push(id);
    } else {
      next[id] = config;
    }
  }
  return { value: { ...(incoming as object), providers: next }, unbound };
}

function connectorEndpoint(connector: Partial<ConnectorRecord>): string {
  return [connector.kind, endpoint(connector.url), endpoint(connector.oauth?.authorizationServerUrl ?? null)].join('|');
}

/**
 * The connectors of a file: one whose server is not the one this browser has under that id loses its sign-in
 * (the caller deletes the vault entries) and asks for it again; tool permissions are this browser's, never the file's.
 */
export function unbindMovedConnectors(
  incoming: Record<string, unknown>[],
  current: ConnectorRecord[],
): { rows: Record<string, unknown>[]; unbound: string[] } {
  const here = new Map(current.map(connector => [connector.id, connector]));
  const unbound: string[] = [];
  const rows = incoming.map(row => {
    const connector = row as unknown as ConnectorRecord;
    const existing = here.get(connector.id);
    const toolPolicy = existing?.toolPolicy ?? {};
    if (existing && connectorEndpoint(existing) === connectorEndpoint(connector)) return { ...row, toolPolicy };
    unbound.push(connector.id);
    return {
      ...row,
      toolPolicy,
      status: connector.authKind === 'none' ? connector.status : 'needs_auth',
      credential: null,
      oauth: connector.oauth ? { ...connector.oauth, hasClientSecret: false } : connector.oauth,
    };
  });
  return { rows, unbound };
}
