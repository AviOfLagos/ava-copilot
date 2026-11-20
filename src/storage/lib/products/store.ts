import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import { activeSeedProfile, workspaceStore } from '../workspaces';
import { SUTURE_AGENT_API, SUTURE_API_SEED, SUTURE_PROFILE, SUTURE_SEED, SUTURE_WORKSPACE } from './seed';
import { cleanProductProfile } from './types';
import type { ProductProfile } from './types';

interface ProductsState {
  // Workspace id → its product
  items: Record<string, ProductProfile>;
  // The seeds that have run (see ./seed.ts): each runs once, so what the user deletes stays deleted
  seeds: string[];
}

const storage = createStorage<ProductsState>(
  'products',
  { items: {}, seeds: [] },
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

let seeding: Promise<ProductsState> | null = null;

/**
 * Seeds the owner's product once, in the owner's build only: the Suture workspace (unless one of that id is
 * there already) and its profile. It runs on an install that was set up before the seed existed too, which is
 * why it does not ride on the workspaces' own first-run seed.
 */
async function ensureSeeded(): Promise<ProductsState> {
  const state = (await storage.get()) ?? { items: {}, seeds: [] };
  if (activeSeedProfile() !== 'avi') return state;
  if (state.seeds.includes(SUTURE_SEED)) return state.seeds.includes(SUTURE_API_SEED) ? state : addApiAddress(state);
  seeding ??= (async () => {
    try {
      if (!(await workspaceStore.get(SUTURE_WORKSPACE.id))) {
        await workspaceStore.save({ ...SUTURE_WORKSPACE, createdAt: Date.now() });
      }
      const fresh = (await storage.get()) ?? state;
      const next: ProductsState = {
        items: fresh.items[SUTURE_PROFILE.workspaceId]
          ? fresh.items
          : { ...fresh.items, [SUTURE_PROFILE.workspaceId]: { ...SUTURE_PROFILE, updatedAt: Date.now() } },
        // A fresh profile carries the API address already
        seeds: [...new Set([...fresh.seeds, SUTURE_SEED, SUTURE_API_SEED])],
      };
      await storage.set(next);
      return next;
    } finally {
      seeding = null;
    }
  })();
  return seeding;
}

/** Gives the seeded Suture profile its API address, once, unless the owner removed the profile or set one. */
async function addApiAddress(state: ProductsState): Promise<ProductsState> {
  const profile = state.items[SUTURE_PROFILE.workspaceId];
  const next: ProductsState = {
    items:
      profile && !profile.agentApi && profile.repo === SUTURE_PROFILE.repo
        ? { ...state.items, [profile.workspaceId]: { ...profile, agentApi: SUTURE_AGENT_API } }
        : state.items,
    seeds: [...state.seeds, SUTURE_API_SEED],
  };
  await storage.set(next);
  return next;
}

export const productStore = {
  ...storage,

  /** Every workspace's product, by workspace id. */
  async all(): Promise<Record<string, ProductProfile>> {
    return (await ensureSeeded()).items;
  },

  /** The product of a workspace, or undefined when it has none. */
  async forWorkspace(workspaceId: string | null | undefined): Promise<ProductProfile | undefined> {
    if (!workspaceId) return undefined;
    return (await ensureSeeded()).items[workspaceId];
  },

  /** Saves a workspace's product, cleaned to the one shape that is kept. */
  async save(profile: ProductProfile): Promise<ProductProfile> {
    const state = await ensureSeeded();
    const clean = { ...cleanProductProfile(profile), updatedAt: Date.now() };
    await storage.set({ ...state, items: { ...state.items, [clean.workspaceId]: clean } });
    return clean;
  },

  async remove(workspaceId: string): Promise<void> {
    const state = await ensureSeeded();
    if (!(workspaceId in state.items)) return;
    const items = { ...state.items };
    delete items[workspaceId];
    await storage.set({ ...state, items });
  },

  /** Runs the one-time seed now (the background does at startup, so the workspace is there before it is asked for). */
  async seed(): Promise<void> {
    await ensureSeeded();
  },
};
