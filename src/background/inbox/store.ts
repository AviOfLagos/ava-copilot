import { db as defaultDb } from '@extension/storage';
import type { AviCopilotDb, InboxItem } from '@extension/storage';
import { RATE_LIMIT_THRESHOLD, RATE_LIMIT_WINDOW_MS, RETENTION_MS } from './constants';

/**
 * The Inbox's own table operations: adding an item (deduped, rate-limited into a digest), and the
 * status changes the panel and the approval flow make. `workflows/inbox.ts` writes to the same table
 * directly for its own approvals and alerts (postToInbox there uses the identical id convention below),
 * which is fine: Dexie hooks on `db.inbox` in `register.ts` react to every writer, not just this one.
 */

// Same convention as workflows/inbox.ts's inboxItemId: the compound-unique index needs a single-field
// primary key, so the id is the two parts joined. Kept independent rather than imported so this stream
// never depends on another stream's internal file; both sides must keep agreeing on the format.
export const inboxItemId = (source: string, externalId: string): string => `${source}|${externalId}`;

export interface InboxDraft {
  source: string;
  externalId: string;
  kind: InboxItem['kind'];
  title: string;
  body: string;
  links?: InboxItem['links'];
  priority?: InboxItem['priority'];
  workspaceId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  approval?: InboxItem['approval'];
}

/** Whether one more item from a source that already landed `recentCount` times should fold into a digest. */
export function shouldFoldIntoDigest(recentCount: number, threshold: number = RATE_LIMIT_THRESHOLD): boolean {
  return recentCount >= threshold;
}

/** The digest's own external id for a source's current rate-limit window: stable within the window. */
export function digestExternalId(now: number, windowMs: number = RATE_LIMIT_WINDOW_MS): string {
  return `digest:${Math.floor(now / windowMs)}`;
}

/** A plain title for a digest, e.g. "6 new messages". */
export function digestTitle(count: number): string {
  return count === 1 ? '1 new message' : `${count} new messages`;
}

function freshDigest(draft: InboxDraft, count: number, now: number): InboxItem {
  return {
    id: inboxItemId(draft.source, digestExternalId(now)),
    source: draft.source,
    externalId: digestExternalId(now),
    kind: 'alert',
    title: digestTitle(count),
    body: 'Several messages arrived close together; open the source to see them all.',
    links: draft.links ?? [],
    priority: 'normal',
    status: 'unread',
    snoozeUntil: null,
    workspaceId: draft.workspaceId ?? null,
    agentId: draft.agentId ?? null,
    runId: null,
    approval: null,
    digestCount: count,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Adds an item once (dedupe by source+externalId). A "message" item from a source already noisy in
 * the last few minutes folds into one digest instead of adding another row. Returns the item as it
 * stands after the call, which may be an existing item (unchanged) or a digest (new or bumped).
 */
export async function addInboxItem(draft: InboxDraft, database: AviCopilotDb = defaultDb): Promise<InboxItem> {
  const id = inboxItemId(draft.source, draft.externalId);
  return database.transaction('rw', database.inbox, async () => {
    const existing = await database.inbox.get(id);
    if (existing) return existing;

    const now = Date.now();
    if (draft.kind === 'message') {
      const recentCount = await database.inbox
        .where('createdAt')
        .above(now - RATE_LIMIT_WINDOW_MS)
        .filter(item => item.source === draft.source && item.kind === 'message')
        .count();
      if (shouldFoldIntoDigest(recentCount)) {
        const digestId = inboxItemId(draft.source, digestExternalId(now));
        const current = await database.inbox.get(digestId);
        let next: InboxItem;
        if (current) {
          const count = (current.digestCount ?? 1) + 1;
          // New messages still arriving means the digest is worth another look, even if it was done
          next = { ...current, title: digestTitle(count), digestCount: count, status: 'unread', updatedAt: now };
        } else {
          next = freshDigest(draft, recentCount + 1, now);
        }
        await database.inbox.put(next);
        return next;
      }
    }

    const item: InboxItem = {
      id,
      source: draft.source,
      externalId: draft.externalId,
      kind: draft.kind,
      title: draft.title.slice(0, 200),
      body: draft.body.slice(0, 8000),
      links: draft.links ?? [],
      priority: draft.priority ?? 'normal',
      status: 'unread',
      snoozeUntil: null,
      workspaceId: draft.workspaceId ?? null,
      agentId: draft.agentId ?? null,
      runId: draft.runId ?? null,
      approval: draft.approval ?? null,
      digestCount: null,
      createdAt: now,
      updatedAt: now,
    };
    await database.inbox.put(item);
    return item;
  });
}

async function touch(id: string, changes: Partial<InboxItem>, database: AviCopilotDb): Promise<boolean> {
  const count = await database.inbox.update(id, { ...changes, updatedAt: Date.now() });
  return count > 0;
}

export const markRead = (id: string, database: AviCopilotDb = defaultDb) => touch(id, { status: 'read' }, database);
export const markUnread = (id: string, database: AviCopilotDb = defaultDb) => touch(id, { status: 'unread' }, database);
export const markDone = (id: string, database: AviCopilotDb = defaultDb) => touch(id, { status: 'done' }, database);

export async function snoozeItem(id: string, until: number, database: AviCopilotDb = defaultDb): Promise<boolean> {
  return touch(id, { status: 'snoozed', snoozeUntil: until }, database);
}

/** The snooze job: wakes an item back to unread, unless the user already changed it by hand. */
export async function wakeSnoozed(id: string, database: AviCopilotDb = defaultDb): Promise<void> {
  const item = await database.inbox.get(id);
  if (item?.status === 'snoozed') await touch(id, { status: 'unread', snoozeUntil: null }, database);
}

/** done items older than the retention window are removed; returns how many. */
export async function pruneDone(database: AviCopilotDb = defaultDb, now: number = Date.now()): Promise<number> {
  return database.inbox
    .where('status')
    .equals('done')
    .filter(item => now - item.updatedAt > RETENTION_MS)
    .delete();
}

export async function unreadCount(database: AviCopilotDb = defaultDb): Promise<number> {
  return database.inbox.where('status').equals('unread').count();
}
