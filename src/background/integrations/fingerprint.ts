import type { ToolAnnotationsRecord, ToolFingerprint } from '@extension/storage';

/**
 * Tool fingerprints: a tool is its name, description and input schema. A server can change any of them at any
 * time (a "rug pull": a harmless tool turns into one that sends data out), so the hash of what the user approved
 * is kept, and a tool whose hash changes is off until the user looks at it again.
 */

// What the stream keeps of a tool from a server's list
export interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotationsRecord;
}

// A server listing more is cut here: nobody reviews thousands of tools, and the list is kept in the database
export const MAX_TOOLS = 500;
// What is kept of a description for showing; the hash covers all of it
const KEPT_DESCRIPTION_CHARS = 4000;

/** JSON with every object's keys sorted, so a server that reorders keys does not look like a change. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, inner]) => inner !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(',')}}`;
}

/** SHA-256 of a tool's name, description and input schema, as hex. */
export async function toolHash(
  tool: Pick<ListedTool, 'name' | 'description' | 'inputSchema'> & Partial<Pick<ListedTool, 'title' | 'annotations'>>,
): Promise<string> {
  // Everything that decides how a tool is shown, described or gated: a change to any of it needs approval again
  const text = canonicalJson({
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
    annotations: tool.annotations ?? null,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export const fingerprintId = (connectorId: string, tool: string) => `${connectorId}:${tool}`;

/** A name a tool can be called by: 1 to 128 characters, no spaces or control characters. */
export function isToolName(name: string): boolean {
  if (name.length < 1 || name.length > 128) return false;
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code <= 32 || code === 127) return false;
  }
  return true;
}

/** The tools of a server's list worth keeping: real names, each once, at most MAX_TOOLS. */
export function cleanListing(tools: unknown[]): ListedTool[] {
  const seen = new Set<string>();
  const kept: ListedTool[] = [];
  for (const raw of tools) {
    const tool = raw as Partial<ListedTool> | null;
    if (!tool || typeof tool.name !== 'string' || !isToolName(tool.name) || seen.has(tool.name)) continue;
    seen.add(tool.name);
    const schema =
      tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema)
        ? tool.inputSchema
        : { type: 'object' };
    kept.push({
      name: tool.name,
      title: typeof tool.title === 'string' ? tool.title : undefined,
      description: typeof tool.description === 'string' ? tool.description : undefined,
      inputSchema: schema,
      annotations: tool.annotations && typeof tool.annotations === 'object' ? tool.annotations : undefined,
    });
    if (kept.length >= MAX_TOOLS) break;
  }
  return kept;
}

export interface Reconciled {
  // Every fingerprint of the connector after the listing, to store
  records: ToolFingerprint[];
  added: string[];
  changed: string[];
  removed: string[];
}

export type HashedTool = ListedTool & { hash: string };

/** Each listed tool with its hash. Hashing is async (WebCrypto), so it happens before any transaction. */
export async function hashTools(listed: ListedTool[]): Promise<HashedTool[]> {
  return Promise.all(listed.map(async tool => ({ ...tool, hash: await toolHash(tool) })));
}

/**
 * Compares a fresh listing with what is stored. A tool seen for the first time is new (off until approved); a
 * tool whose hash moved is changed (off until approved again, with what it looked like kept to show the
 * difference); a tool no longer listed is missing (kept, so an unchanged return needs no new approval).
 * Synchronous, so it can run inside the transaction that reads and writes the fingerprints.
 */
export function reconcileHashed(
  connectorId: string,
  listed: HashedTool[],
  stored: ToolFingerprint[],
  now: number,
): Reconciled {
  const byName = new Map(stored.map(record => [record.tool, record]));
  const records: ToolFingerprint[] = [];
  const added: string[] = [];
  const changed: string[] = [];
  const listedNames = new Set<string>();

  for (const tool of listed) {
    listedNames.add(tool.name);
    const { hash } = tool;
    const shown = {
      title: tool.title ?? tool.annotations?.title ?? null,
      description: (tool.description ?? '').slice(0, KEPT_DESCRIPTION_CHARS),
      inputSchema: tool.inputSchema,
      annotations: tool.annotations ?? null,
    };
    const before = byName.get(tool.name);
    if (!before) {
      added.push(tool.name);
      records.push({
        id: fingerprintId(connectorId, tool.name),
        connectorId,
        tool: tool.name,
        hash,
        approved: false,
        seenAt: now,
        firstSeenAt: now,
        everApproved: false,
        changedAt: null,
        previous: null,
        missing: false,
        ...shown,
      });
      continue;
    }
    if (before.hash === hash) {
      records.push({ ...before, ...shown, seenAt: now, missing: false });
      continue;
    }
    changed.push(tool.name);
    records.push({
      ...before,
      ...shown,
      hash,
      approved: false,
      everApproved: Boolean(before.everApproved || before.approved),
      changedAt: now,
      seenAt: now,
      missing: false,
      // What the user last approved stays the reference until they approve again
      previous: before.approved
        ? { description: before.description ?? '', inputSchema: before.inputSchema ?? {} }
        : (before.previous ?? null),
    });
  }

  const removed: string[] = [];
  for (const record of stored) {
    if (listedNames.has(record.tool)) continue;
    if (!record.missing) removed.push(record.tool);
    records.push({ ...record, missing: true });
  }
  return { records, added, changed, removed };
}

/** reconcileHashed for a listing not hashed yet. */
export async function reconcileTools(
  connectorId: string,
  listed: ListedTool[],
  stored: ToolFingerprint[],
  now: number,
): Promise<Reconciled> {
  return reconcileHashed(connectorId, await hashTools(listed), stored, now);
}
