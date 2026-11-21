import { db as defaultDb } from '../threads/db';
import type { AviCopilotDb } from '../threads/db';
import { feedbackRecordId, teamContactId } from './types';
import type {
  FeedbackRecord,
  LedgerEntry,
  SuppressedAddress,
  TeamChannel,
  TeamContact,
  TeamItem,
  TeamItemStatus,
} from './types';

/**
 * The growth team's items and ledger, over a database that defaults to the extension's own. Tests pass their
 * own database. The background is the only writer; the panel reads.
 */
export function createTeamStore(db: AviCopilotDb = defaultDb) {
  return {
    /**
     * Adds an item once. The id carries its do-once key, so proposing the same thing again returns the item as
     * it stands (queued, done, declined…) and adds nothing.
     */
    async add(item: TeamItem): Promise<{ item: TeamItem; added: boolean }> {
      return db.transaction('rw', db.teamItems, async () => {
        const existing = await db.teamItems.get(item.id);
        if (existing) return { item: existing, added: false };
        await db.teamItems.add(item);
        return { item, added: true };
      });
    },

    get: (id: string) => db.teamItems.get(id),

    async update(id: string, changes: Partial<TeamItem>): Promise<TeamItem | null> {
      return db.transaction('rw', db.teamItems, async () => {
        const item = await db.teamItems.get(id);
        if (!item) return null;
        const next = { ...item, ...changes, id: item.id, workspaceId: item.workspaceId };
        await db.teamItems.put(next);
        return next;
      });
    },

    /**
     * Moves an item out of 'queued', once. Two answers to the same item (a batch tap and an item tap landing
     * together) cannot both carry it out: only the first gets it back.
     */
    async decide(id: string, status: Exclude<TeamItemStatus, 'queued'>, note: string, at: number) {
      return db.transaction('rw', db.teamItems, async () => {
        const item = await db.teamItems.get(id);
        if (!item || item.status !== 'queued') return null;
        const next: TeamItem = { ...item, status, note, decidedAt: at };
        await db.teamItems.put(next);
        return next;
      });
    },

    inBatch: (batchId: string) => db.teamItems.where('batchId').equals(batchId).toArray(),

    forWorkspace: (workspaceId: string) => db.teamItems.where('workspaceId').equals(workspaceId).toArray(),

    /** Items of one kind of work made since a moment, whatever became of them: what the daily limits count. */
    async since(workspaceId: string, at: number): Promise<TeamItem[]> {
      return (await db.teamItems.where('workspaceId').equals(workspaceId).toArray()).filter(
        item => item.createdAt >= at,
      );
    },

    /**
     * Writes a ledger line unless `allowed` says no, in one transaction: the lines are read, the limit is
     * checked and the new line is written with nothing able to slip in between. One item makes one line.
     *
     * @param allowed - Given the workspace's lines so far and the ids of their items that are done (carried out in
     *   the world, not only agreed), why this one may not be added, or null when it may
     */
    async record(
      entry: LedgerEntry,
      allowed: (entries: LedgerEntry[], doneItemIds: ReadonlySet<string>) => string | null,
    ): Promise<{ ok: true; entry: LedgerEntry } | { ok: false; why: string }> {
      return db.transaction('rw', db.teamLedger, db.teamItems, async () => {
        const entries = await db.teamLedger.where('workspaceId').equals(entry.workspaceId).toArray();
        const same = entries.find(line => line.itemId === entry.itemId && line.kind === entry.kind);
        if (same) return { ok: true as const, entry: same };
        const items = await db.teamItems.bulkGet(entries.map(line => line.itemId));
        const done = new Set(items.filter(item => item?.status === 'done').map(item => item!.id));
        const why = allowed(entries, done);
        if (why) return { ok: false as const, why };
        await db.teamLedger.add(entry);
        return { ok: true as const, entry };
      });
    },

    ledger: (workspaceId: string) => db.teamLedger.where('workspaceId').equals(workspaceId).toArray(),

    /** The feedback ids of a workspace already sorted, out of `ids`. */
    async sortedFeedback(workspaceId: string, ids: readonly string[]): Promise<Set<string>> {
      const found = await db.teamFeedback.bulkGet(ids.map(id => feedbackRecordId(workspaceId, id)));
      return new Set(found.filter(Boolean).map(record => record!.feedbackId));
    },

    /**
     * Writes how a feedback item was sorted, once: the first sort stands, and the count of feature requests on the
     * same topic (this one included) comes back from the same transaction, so two sorts landing together count
     * right.
     */
    async sortFeedback(
      record: FeedbackRecord,
    ): Promise<{ record: FeedbackRecord; added: boolean; topicCount: number }> {
      return db.transaction('rw', db.teamFeedback, async () => {
        const existing = await db.teamFeedback.get(record.id);
        const kept = existing ?? record;
        if (!existing) await db.teamFeedback.add(record);
        const topicCount = kept.topic
          ? await db.teamFeedback
              .where('topic')
              .equals(kept.topic)
              .filter(row => row.workspaceId === kept.workspaceId && row.sort === 'feature')
              .count()
          : 0;
        return { record: kept, added: !existing, topicCount };
      });
    },

    linkFeedback: (id: string, itemId: string) => db.teamFeedback.update(id, { itemId }),
    forgetFeedback: (id: string) => db.teamFeedback.delete(id),

    // ── The Product Marketing Manager's contacts and channels (#75) ──

    contact: (workspaceId: string, email: string) => db.teamContacts.get(teamContactId(workspaceId, email)),
    /** People first written to since `from`, for the day's limit. */
    contactsSince: (workspaceId: string, from: number) =>
      db.teamContacts
        .where('firstAt')
        .aboveOrEqual(from)
        .filter(row => row.workspaceId === workspaceId)
        .count(),
    saveContact: (contact: TeamContact) => db.teamContacts.put(contact),
    forgetContact: (id: string) => db.teamContacts.delete(id),

    suppressed: (email: string) => db.teamSuppressed.get(email.trim().toLowerCase()),
    /** Stops all writing to an address, for good, whatever the product. The first reason stands. */
    async suppress(email: string, why: SuppressedAddress['why'], at: number): Promise<void> {
      const key = email.trim().toLowerCase();
      await db.transaction('rw', db.teamSuppressed, async () => {
        if (!(await db.teamSuppressed.get(key))) await db.teamSuppressed.add({ email: key, why, at });
      });
    },

    channels: (workspaceId: string) => db.teamChannels.where('workspaceId').equals(workspaceId).toArray(),
    saveChannel: (channel: TeamChannel) => db.teamChannels.put(channel),
  };
}

export type TeamStore = ReturnType<typeof createTeamStore>;
export const teamStore = createTeamStore();
