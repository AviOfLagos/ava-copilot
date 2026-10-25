import type { ConnectorRecord, ProviderConfig } from '@extension/storage';

/**
 * What a backup may carry, and what a restore may believe.
 *
 * 1. No secret travels inside a snapshot or a file: fields whose names say they hold one (apiKey, token,
 *    accessToken, refreshToken, secret, password, clientSecret, authorization, cookie…, any case, at any depth) are
 *    emptied before a snapshot is written. Keys go only through the Keychain path (./service.ts).
 * 2. A file from disk is not the user's own Ava Brain: anyone could have made it. Restoring one keeps this
 *    browser's security settings (firewall, what asks first, installed skills, approved connector tools), and
 *    never takes a key binding, sign-in, workspace scope or tool rule from the file: a provider or connector keeps
 *    this browser's own only when its endpoint is the one it has here now, so a crafted file cannot point a saved
 *    key at another server or name another saved key.
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

/**
 * Storage keys a file restore leaves as they are on this browser. The Obsidian vault on the Mac is one: a file must
 * not point Ava Brain at a folder (a Ava Brain backup, which this Mac made, restores it).
 */
export const FILE_KEEP_STORAGE_KEYS = new Set([
  'firewall-settings',
  'gate-settings',
  'skills',
  'workflow-settings',
  'obsidian-vault',
  'obsidian-vault-sync',
]);
/** Tables a file restore leaves as they are: which connector tools the user approved, as they were. */
export const FILE_KEEP_TABLES = new Set(['toolFingerprints']);

const endpoint = (url: string | null | undefined) => (url ?? '').trim().replace(/\/+$/, '').toLowerCase();

function providerEndpoint(config: Pick<ProviderConfig, 'type' | 'baseUrl'>): string {
  return `${config.type ?? ''}|${endpoint(config.baseUrl)}`;
}

/**
 * The model providers of a file. A file never says which saved key a provider uses: its keyRef, hasKey and keyLast4
 * are dropped, and a provider keeps this browser's own binding only when its endpoint is the one it has here now.
 * Otherwise it has no key until the user enters one. Returns the providers whose key was unbound.
 */
export function unbindMovedProviders(incoming: unknown, current: unknown): { value: unknown; unbound: string[] } {
  const providers = (incoming as { providers?: Record<string, ProviderConfig> } | null)?.providers;
  if (!providers || typeof providers !== 'object') return { value: incoming, unbound: [] };
  const here = (current as { providers?: Record<string, ProviderConfig> } | null)?.providers ?? {};
  const unbound: string[] = [];
  const next: Record<string, ProviderConfig> = {};
  for (const [id, config] of Object.entries(providers)) {
    const rest: Partial<ProviderConfig> = { ...config };
    delete rest.keyRef;
    delete rest.keyLast4;
    const local = here[id];
    const apiKey = PLACEHOLDERS.has(config?.apiKey ?? '') ? (config?.apiKey ?? '') : '';
    if (local && providerEndpoint(local) === providerEndpoint(config)) {
      const binding: Partial<ProviderConfig> = { hasKey: local.hasKey };
      if (local.keyRef) binding.keyRef = local.keyRef;
      if (local.keyLast4) binding.keyLast4 = local.keyLast4;
      next[id] = { ...rest, apiKey: local.apiKey ?? apiKey, ...binding } as ProviderConfig;
      continue;
    }
    if (config?.keyRef || config?.hasKey) unbound.push(id);
    next[id] = { ...rest, apiKey, hasKey: false } as ProviderConfig;
  }
  return { value: { ...(incoming as object), providers: next }, unbound };
}

function connectorEndpoint(connector: Partial<ConnectorRecord>): string {
  return [connector.kind, endpoint(connector.url), endpoint(connector.oauth?.authorizationServerUrl ?? null)].join('|');
}

// What decides where a connector's sign-in goes and what it may do: always this browser's, never a file's
const CONNECTOR_SECURITY_FIELDS = [
  'authKind',
  'secretRef',
  'tokenHeader',
  'oauth',
  'credential',
  'workspaceIds',
  'toolPolicy',
  'status',
] as const;

/**
 * The connectors of a file. One whose server is the one this browser has under that id keeps this browser's
 * sign-in, scope and tool permissions (only its descriptive fields come from the file). Any other, a new one
 * included, starts disabled with no sign-in and every tool asking first, so the user confirms the server; the caller
 * deletes its vault entries and approved tool pins.
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
    if (existing && connectorEndpoint(existing) === connectorEndpoint(connector)) {
      const kept: Record<string, unknown> = { ...row };
      for (const field of CONNECTOR_SECURITY_FIELDS)
        kept[field] = (existing as unknown as Record<string, unknown>)[field];
      return kept;
    }
    unbound.push(connector.id);
    return {
      ...row,
      authKind: connector.authKind,
      secretRef: null,
      workspaceIds: [],
      toolPolicy: {},
      status: 'disabled',
      credential: null,
      oauth: connector.oauth ? { ...connector.oauth, hasClientSecret: false } : connector.oauth,
    };
  });
  return { rows, unbound };
}
