import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';

export type AccountPlatform = 'google' | 'x' | 'linkedin' | 'youtube' | 'instagram' | 'slack' | 'github';

export const ACCOUNT_PLATFORMS: AccountPlatform[] = [
  'google',
  'x',
  'linkedin',
  'youtube',
  'instagram',
  'slack',
  'github',
];

/**
 * One part of the user's life kept apart from the others: a company, an event, a side project. Its
 * chats, meetings and knowledge stay in it, and the agent acts as its accounts.
 */
export interface Workspace {
  id: string;
  name: string;
  // What it is and anything the copilot should know, in the user's words
  about: string;
  // Words that mark a request as this workspace's: people, products, domains
  keywords: string[];
  // The account to act as on each site, e.g. google: "avi@nexprove.com", x: "@nexprove"
  accounts: Partial<Record<AccountPlatform, string>>;
  createdAt: number;
}

interface WorkspacesState {
  items: Workspace[];
  // The defaults are added once, so deleting one keeps it deleted
  seeded: boolean;
}

const DEFAULTS: Omit<Workspace, 'createdAt'>[] = [
  { id: 'nexprove', name: 'Nexprove', about: 'My company.', keywords: ['nexprove', 'next prove'], accounts: {} },
  {
    id: 'tech-ember-fest',
    name: 'Tech Ember Fest',
    about: 'The Tech Ember Fest event.',
    keywords: ['tech ember', 'techember', 'tech ember fest'],
    accounts: {},
  },
  { id: 'ellum-ai', name: 'Ellum AI', about: '', keywords: ['ellum', 'ellum ai'], accounts: {} },
];

const storage = createStorage<WorkspacesState>(
  'workspaces',
  { items: [], seeded: false },
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

/** A short id from a name, unique among the ids given. */
export function workspaceId(name: string, taken: string[] = []): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'workspace';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

export const workspaceStore = {
  ...storage,

  async list(): Promise<Workspace[]> {
    const state = (await storage.get()) ?? { items: [], seeded: false };
    if (state.seeded) return state.items;
    const items = [...state.items, ...DEFAULTS.map(item => ({ ...item, createdAt: Date.now() }))];
    await storage.set({ items, seeded: true });
    return items;
  },

  async get(id: string | null | undefined): Promise<Workspace | undefined> {
    if (!id) return undefined;
    return (await workspaceStore.list()).find(item => item.id === id);
  },

  /** Adds a workspace, or replaces the one with its id. */
  async save(workspace: Workspace): Promise<void> {
    const items = await workspaceStore.list();
    const at = items.findIndex(item => item.id === workspace.id);
    const clean: Workspace = {
      ...workspace,
      name: workspace.name.trim().slice(0, 60),
      about: workspace.about.slice(0, 4000),
      keywords: [...new Set(workspace.keywords.map(word => word.trim().toLowerCase()).filter(Boolean))].slice(0, 40),
    };
    await storage.set({
      items: at >= 0 ? items.map((item, i) => (i === at ? clean : item)) : [...items, clean],
      seeded: true,
    });
  },

  async remove(id: string): Promise<void> {
    await storage.set({ items: (await workspaceStore.list()).filter(item => item.id !== id), seeded: true });
  },
};

/** The domain of an email address, which marks its workspace too: "avi@nexprove.com" gives "nexprove.com". */
function domainOf(account: string | undefined): string | null {
  const match = /@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(account?.trim() ?? '');
  return match ? match[1].toLowerCase() : null;
}

/** Whether a phrase appears in the text as whole words. */
function mentions(text: string, phrase: string): boolean {
  const escaped = phrase
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s*');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(text);
}

/**
 * Which workspace a request belongs to, from its words: the workspace's name, its keywords, or its
 * Google account's domain. None when nothing matches, or when more than one workspace does: then the
 * user decides, since mixing two is the mistake to avoid.
 */
export function routeWorkspace(text: string, workspaces: Workspace[]): Workspace | null {
  const lower = text.toLowerCase();
  const matched = workspaces.filter(workspace =>
    [workspace.name, ...workspace.keywords, domainOf(workspace.accounts.google) ?? '']
      .filter(phrase => phrase.trim().length >= 3)
      .some(phrase => mentions(lower, phrase)),
  );
  return matched.length === 1 ? matched[0] : null;
}

// Addresses anyone can have: their domain says nothing about a workspace
const PUBLIC_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'yahoo.com',
  'icloud.com',
]);

/**
 * The workspace a Google account belongs to: the one set to that account, else the one whose account
 * shares its company domain.
 */
export function workspaceForAccount(email: string, workspaces: Workspace[]): Workspace | null {
  const address = email.trim().toLowerCase();
  const exact = workspaces.filter(item => item.accounts.google?.trim().toLowerCase() === address);
  if (exact.length === 1) return exact[0];
  const domain = domainOf(address);
  if (!domain || PUBLIC_DOMAINS.has(domain)) return null;
  const same = workspaces.filter(item => domainOf(item.accounts.google) === domain);
  return same.length === 1 ? same[0] : null;
}
