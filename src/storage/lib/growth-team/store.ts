import { db as defaultDb } from '../threads/db';
import type { AviCopilotDb } from '../threads/db';
import type { LedgerEntry, TeamItem, TeamItemStatus } from './types';

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
  };
}

export type TeamStore = ReturnType<typeof createTeamStore>;
export const teamStore = createTeamStore();
