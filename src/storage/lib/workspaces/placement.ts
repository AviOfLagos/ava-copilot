import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
import type { WorkspaceSetBy } from '../tasks/types';

// What Ava remembers about placing things in workspaces (docs/pm-desk.md, Part 3): every move she or Avi made (so it
// can be undone), what she offers and waits for a yes on, and what Avi turned down. Kept in `storage.local`, so it
// needs no database step; the background is the only writer.

export type PlaceKind = 'task' | 'thread' | 'meeting' | 'kb';

export interface PlaceRef {
  kind: PlaceKind;
  id: string;
}

/** Where an item was before a move, and what it was set to, so an undo puts back exactly that and nothing newer. */
export interface MovedItem extends PlaceRef {
  fromWorkspaceId: string | null;
  // Absent on records from before this field existed
  fromSetBy: WorkspaceSetBy | null;
  toSetBy: WorkspaceSetBy;
}

export type MoveBy = 'sheet' | 'offer' | 'rule' | 'voice' | 'agent';

export interface WorkspaceMove {
  // 'wsm_' + 10 base32 chars
  id: string;
  by: MoveBy;
  workspaceId: string;
  workspaceName: string;
  // The workspace was made by this move: undoing it takes the workspace away again (when nothing else is in it)
  createdWorkspace: boolean;
  items: MovedItem[];
  at: number;
  undoneAt: number | null;
  // When the brief told Avi about it (rule moves are told once)
  reportedAt: number | null;
}

export type OfferKind = 'guess' | 'wrong' | 'sheet';

export interface OfferItem extends PlaceRef {
  title: string;
  fromWorkspaceId: string | null;
}

/** Something Ava thinks should move and has not moved: it waits for Avi's yes. */
export interface WorkspaceOffer {
  // 'wso_' + 10 base32 chars
  id: string;
  // guess: a model's guess for things in no workspace; wrong: things a rule or Ava placed that fit another workspace
  // better; sheet: a workspace made by voice or chat, and the things in no workspace that match it
  kind: OfferKind;
  workspaceId: string;
  workspaceName: string;
  items: OfferItem[];
  status: 'open' | 'moved' | 'dismissed';
  createdAt: number;
  resolvedAt: number | null;
  // The move that carried it out
  moveId: string | null;
}

export interface PlacementState {
  moves: WorkspaceMove[];
  offers: WorkspaceOffer[];
  // "kind:id>workspaceId" pairs Avi said no to: never moved there by a rule or offered again
  declined: string[];
  // "kind:id" → when the model last guessed it (so the same thing is not asked about every day)
  guessed: Record<string, number>;
}

export const emptyPlacementState = (): PlacementState => ({ moves: [], offers: [], declined: [], guessed: {} });

const MAX_MOVES = 60;
const MAX_OFFERS = 80;
const MAX_DECLINED = 800;
const MAX_GUESSED = 1500;

export const refKey = (ref: PlaceRef): string => `${ref.kind}:${ref.id}`;
export const declinedKey = (ref: PlaceRef, workspaceId: string): string => `${refKey(ref)}>${workspaceId}`;

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const randomId = (prefix: string): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return prefix + Array.from(bytes, byte => BASE32[byte % 32]).join('');
};
export const newMoveId = (): string => randomId('wsm_');
export const newOfferId = (): string => randomId('wso_');
export const isMoveId = (value: string): boolean => /^wsm_[a-z2-7]{10}$/.test(value);
export const isOfferId = (value: string): boolean => /^wso_[a-z2-7]{10}$/.test(value);

export interface PlacementBacking {
  get(): Promise<PlacementState>;
  set(state: PlacementState): Promise<void>;
}

/** The store over a backing: the extension's own `storage.local`, or memory in a test. One change at a time. */
export function createPlacementStore(backing: PlacementBacking, now: () => number = Date.now) {
  let chain: Promise<unknown> = Promise.resolve();
  const change = <T>(run: (state: PlacementState) => T | Promise<T>): Promise<T> => {
    const next = chain.then(async () => {
      const state = { ...emptyPlacementState(), ...(await backing.get()) };
      const result = await run(state);
      state.moves = state.moves.slice(-MAX_MOVES);
      state.offers = state.offers.slice(-MAX_OFFERS);
      state.declined = state.declined.slice(-MAX_DECLINED);
      const guessed = Object.entries(state.guessed);
      if (guessed.length > MAX_GUESSED) {
        state.guessed = Object.fromEntries(guessed.sort((a, b) => b[1] - a[1]).slice(0, MAX_GUESSED));
      }
      await backing.set(state);
      return result;
    });
    chain = next.catch(() => undefined);
    return next;
  };

  return {
    async state(): Promise<PlacementState> {
      return { ...emptyPlacementState(), ...(await backing.get()) };
    },

    addMove(move: Omit<WorkspaceMove, 'id' | 'at' | 'undoneAt' | 'reportedAt'>): Promise<WorkspaceMove> {
      return change(state => {
        const made: WorkspaceMove = { ...move, id: newMoveId(), at: now(), undoneAt: null, reportedAt: null };
        state.moves.push(made);
        return made;
      });
    },

    async getMove(id: string): Promise<WorkspaceMove | undefined> {
      return (await this.state()).moves.find(move => move.id === id);
    },

    /** Marks a move undone, once. Returns the move when this call did it, else undefined. */
    markUndone(id: string): Promise<WorkspaceMove | undefined> {
      return change(state => {
        const move = state.moves.find(item => item.id === id);
        if (!move || move.undoneAt !== null) return undefined;
        move.undoneAt = now();
        return { ...move };
      });
    },

    /** Rule moves the brief has not told Avi about yet (and he has not undone). */
    async unreportedRuleMoves(): Promise<WorkspaceMove[]> {
      return (await this.state()).moves.filter(
        move => move.by === 'rule' && move.reportedAt === null && move.undoneAt === null && move.items.length > 0,
      );
    },

    markReported(ids: string[]): Promise<void> {
      return change(state => {
        for (const move of state.moves) if (ids.includes(move.id) && move.reportedAt === null) move.reportedAt = now();
      });
    },

    /** Adds an offer unless the same things are already offered for the same workspace. Returns the offer, new or old. */
    addOffer(offer: Omit<WorkspaceOffer, 'id' | 'status' | 'createdAt' | 'resolvedAt' | 'moveId'>): Promise<{
      offer: WorkspaceOffer;
      added: boolean;
    }> {
      return change(state => {
        const wanted = new Set(offer.items.map(refKey));
        const same = state.offers.find(
          other =>
            other.status === 'open' &&
            other.workspaceId === offer.workspaceId &&
            other.kind === offer.kind &&
            other.items.length === wanted.size &&
            other.items.every(item => wanted.has(refKey(item))),
        );
        if (same) return { offer: same, added: false };
        const made: WorkspaceOffer = {
          ...offer,
          id: newOfferId(),
          status: 'open',
          createdAt: now(),
          resolvedAt: null,
          moveId: null,
        };
        state.offers.push(made);
        return { offer: made, added: true };
      });
    },

    async getOffer(id: string): Promise<WorkspaceOffer | undefined> {
      return (await this.state()).offers.find(offer => offer.id === id);
    },

    async openOffers(): Promise<WorkspaceOffer[]> {
      return (await this.state()).offers.filter(offer => offer.status === 'open');
    },

    /** Closes an offer once. `declined` records Avi's no for each of its items. */
    resolveOffer(
      id: string,
      result: { status: 'moved'; moveId: string | null } | { status: 'dismissed' },
    ): Promise<WorkspaceOffer | undefined> {
      return change(state => {
        const offer = state.offers.find(item => item.id === id);
        if (!offer || offer.status !== 'open') return undefined;
        offer.status = result.status;
        offer.resolvedAt = now();
        if (result.status === 'moved') offer.moveId = result.moveId;
        else for (const item of offer.items) state.declined.push(declinedKey(item, offer.workspaceId));
        return { ...offer };
      });
    },

    /** Records that Avi said no to these things going to that workspace. */
    decline(refs: PlaceRef[], workspaceId: string): Promise<void> {
      return change(state => {
        for (const ref of refs) state.declined.push(declinedKey(ref, workspaceId));
      });
    },

    markGuessed(refs: PlaceRef[]): Promise<void> {
      return change(state => {
        for (const ref of refs) state.guessed[refKey(ref)] = now();
      });
    },
  };
}

export type PlacementStore = ReturnType<typeof createPlacementStore>;

const storage = createStorage<PlacementState>('workspace-placement', emptyPlacementState(), {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

/** The one store the extension uses. Pages read it live; only the background changes it. */
export const workspacePlacement = createPlacementStore({
  get: async () => (await storage.get()) ?? emptyPlacementState(),
  set: state => storage.set(state),
});

/** Pages read the state through this, to follow it live (`useStorage`). */
export const placementStorage = storage;
