import { nameKey } from '../people/names';
import { db as defaultDb } from '../threads/db';
import type { AviCopilotDb } from '../threads/db';
import type { PersonUpdate } from './types';

// The person updates (docs/pm-desk.md, Part 9.1). The background is the only writer; pages read `db.personUpdates`
// with live queries and send `followups_*` commands.

// A person's page and status read at most this many updates
const RECENT_MAX = 50;
const LIST_MAX = 30;

const clean = (items: string[] | undefined) =>
  (items ?? [])
    .map(item => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, LIST_MAX)
    .map(item => item.slice(0, 300));

export function createPersonUpdateStore(db: AviCopilotDb = defaultDb) {
  return {
    db,

    /** Saves an update (the same id again replaces it, keeping Avi's answers to its offers). */
    async save(update: PersonUpdate): Promise<PersonUpdate> {
      return db.transaction('rw', db.personUpdates, async () => {
        const before = await db.personUpdates.get(update.id);
        const answered = new Map(
          (before?.offers ?? []).filter(offer => offer.answer).map(offer => [offer.taskId, offer]),
        );
        const saved: PersonUpdate = {
          ...update,
          name: update.name.replace(/\s+/g, ' ').trim().slice(0, 120),
          did: clean(update.did),
          doing: clean(update.doing),
          next: clean(update.next),
          blockers: clean(update.blockers),
          ...(update.byText ? { byText: update.byText.slice(0, 120) } : {}),
          ...(update.offers
            ? { offers: update.offers.map(offer => answered.get(offer.taskId) ?? offer) }
            : before?.offers
              ? { offers: before.offers }
              : {}),
        };
        if (!saved.by) delete saved.by;
        if (!saved.byText) delete saved.byText;
        await db.personUpdates.put(saved);
        return saved;
      });
    },

    get: (id: string): Promise<PersonUpdate | undefined> => db.personUpdates.get(id),

    /** A person's updates, newest first. */
    async forPerson(personId: string, limit = RECENT_MAX): Promise<PersonUpdate[]> {
      const linked = await db.personUpdates.where('personId').equals(personId).toArray();
      return linked.sort((a, b) => b.at - a.at).slice(0, limit);
    },

    /** The updates one source gave (a meeting's), in the order said. */
    async forSource(kind: PersonUpdate['source']['kind'], id: string): Promise<PersonUpdate[]> {
      const updates = await db.personUpdates.where('source.id').equals(id).toArray();
      return updates
        .filter(update => update.source.kind === kind)
        .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
    },

    /** Updates said since a moment, oldest first. */
    since: (at: number): Promise<PersonUpdate[]> => db.personUpdates.where('at').aboveOrEqual(at).sortBy('at'),

    /** Avi's answer to one "Mark done?" offer. Returns the update, or null when it or the offer is gone. */
    async answerOffer(id: string, taskId: string, answer: 'done' | 'no', at: number): Promise<PersonUpdate | null> {
      return db.transaction('rw', db.personUpdates, async () => {
        const update = await db.personUpdates.get(id);
        const offer = update?.offers?.find(item => item.taskId === taskId);
        if (!update || !offer) return null;
        const offers = update.offers!.map(item =>
          item.taskId === taskId ? { ...item, answer, answeredAt: at } : item,
        );
        await db.personUpdates.update(id, { offers });
        return { ...update, offers };
      });
    },

    /** Links the updates said under a name, in one workspace, to the person it turned out to be. */
    async link(names: string[], personId: string, workspaceId: string | null): Promise<number> {
      const keys = new Set(names.map(nameKey).filter(Boolean));
      if (!keys.size) return 0;
      return db.personUpdates
        .filter(
          update => update.personId === null && update.workspaceId === workspaceId && keys.has(nameKey(update.name)),
        )
        .modify({ personId });
    },

    /** Re-points a merged person's updates; a removed person's keep their name and lose the link. */
    replacePerson: (fromId: string, toId: string | null): Promise<number> =>
      db.personUpdates.where('personId').equals(fromId).modify({ personId: toId }),
  };
}

export type PersonUpdateStore = ReturnType<typeof createPersonUpdateStore>;

export const personUpdateStore = createPersonUpdateStore();
