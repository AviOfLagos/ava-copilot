import { createPlacementStore, emptyPlacementState, newPerson, withKeys } from '@extension/storage';
import type { PlacementState, Person, WorkspaceSetBy, Workspace } from '@extension/storage';
import type { InboxDraft } from '../../inbox/store';
import type { ItemSource } from '../items';
import type { PlaceDeps } from '../place';
import type { PlaceItem } from '../rules';
import type { SortDeps } from '../sort';

// Made-up names only: this repository is public

export const workspace = (id: string, name: string, keywords: string[] = [], google?: string): Workspace => ({
  id,
  name,
  about: '',
  keywords,
  accounts: google ? { google } : {},
  createdAt: 0,
});

export const ORCHID = workspace('orchid', 'Orchid Labs', ['orchid']);
export const HARBOR = workspace('harbor', 'Harbor', ['harbour', 'dockside']);

export const item = (
  id: string,
  text: string,
  fields: Partial<Omit<PlaceItem, 'ref'>> & { kind?: PlaceItem['ref']['kind'] } = {},
): PlaceItem => {
  const { kind = 'task', ...rest } = fields;
  return { ref: { kind, id }, title: text, text, names: [], workspaceId: null, setBy: null, ...rest };
};

export const person = (name: string, workspaceIds: string[], aliases: string[] = []): Person =>
  withKeys({
    ...newPerson(name, 0),
    workspaceIds,
    aliases: aliases.map(text => ({ text, workspaceId: null, from: 'avi' as const })),
  });

/** An in-memory stand-in for the real item source: the same contract, no database. */
export class MemoryItems implements ItemSource {
  items = new Map<string, PlaceItem>();
  moved: string[] = [];
  constructor(items: PlaceItem[] = []) {
    for (const one of items) this.items.set(`${one.ref.kind}:${one.ref.id}`, one);
  }
  async list() {
    return [...this.items.values()].map(one => ({ ...one }));
  }
  async get(ref: { kind: string; id: string }) {
    const found = this.items.get(`${ref.kind}:${ref.id}`);
    return found ? { ...found } : null;
  }
  async set(ref: { kind: string; id: string }, workspaceId: string | null, setBy: WorkspaceSetBy | null) {
    const found = this.items.get(`${ref.kind}:${ref.id}`);
    if (!found) return false;
    found.workspaceId = workspaceId;
    found.setBy = setBy;
    this.moved.push(`${ref.kind}:${ref.id}`);
    return true;
  }
  async countIn(workspaceId: string) {
    return [...this.items.values()].filter(one => one.workspaceId === workspaceId).length;
  }
  at(id: string, kind: PlaceItem['ref']['kind'] = 'task') {
    return this.items.get(`${kind}:${id}`)!;
  }
}

export interface Rig extends SortDeps {
  source: MemoryItems;
  book: Workspace[];
  inboxItems: InboxDraft[];
  closed: string[];
  state: () => Promise<PlacementState>;
  clock: { now: number };
}

/** Everything the placing functions need, in memory. */
export function rig(
  items: PlaceItem[],
  options: { workspaces?: Workspace[]; people?: Person[]; model?: SortDeps['model'] } = {},
): Rig {
  let stored: PlacementState = emptyPlacementState();
  const clock = { now: Date.UTC(2026, 10, 22, 9) };
  const placement = createPlacementStore(
    {
      get: async () => structuredClone(stored),
      set: async state => {
        stored = structuredClone(state);
      },
    },
    () => clock.now,
  );
  const book = [...(options.workspaces ?? [ORCHID, HARBOR])];
  const source = new MemoryItems(items);
  const inboxItems: InboxDraft[] = [];
  const closed: string[] = [];
  const deps: PlaceDeps & Pick<SortDeps, 'people' | 'model'> = {
    items: source,
    placement,
    workspaces: {
      list: async () => [...book],
      save: async next => {
        const at = book.findIndex(other => other.id === next.id);
        if (at >= 0) book[at] = next;
        else book.push(next);
      },
      remove: async id => {
        const at = book.findIndex(other => other.id === id);
        if (at >= 0) book.splice(at, 1);
      },
    },
    inbox: {
      add: async draft => {
        inboxItems.push(draft);
      },
      close: async (source, externalId) => {
        closed.push(`${source}|${externalId}`);
      },
    },
    now: () => clock.now,
    people: { list: async () => options.people ?? [] },
    model: options.model ?? null,
  };
  return Object.assign(deps, { source, book, inboxItems, closed, state: () => placement.state(), clock }) as Rig;
}
