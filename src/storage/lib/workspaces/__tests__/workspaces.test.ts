import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeWorkspace, workspaceForAccount, workspaceId } from '../workspaces';
import type { Workspace } from '../workspaces';

// base.ts reads globalThis.chrome when it is imported, so the mock must exist before the import
const data = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in values).map(k => [k, values[k]])),
        set: async (items: Record<string, unknown>) => Object.assign(values, items),
        onChanged: { addListener: () => undefined },
      },
    },
  });
  return values;
});

const { activeSeedProfile, workspaceStore } = await import('../workspaces');

const ws = (id: string, name: string, keywords: string[], google?: string): Workspace => ({
  id,
  name,
  about: '',
  keywords,
  accounts: google ? { google } : {},
  createdAt: 0,
});
const all = [
  ws('nexprove', 'Nexprove', ['nexprove'], 'avi@nexprove.com'),
  ws('tef', 'Tech Ember Fest', ['tech ember', 'techember']),
  ws('ellum', 'Ellum AI', ['ellum']),
];

describe('routeWorkspace', () => {
  it('finds the workspace a request names, by name, keyword or email domain', () => {
    expect(routeWorkspace('Draft the Tech Ember Fest sponsor email', all)?.id).toBe('tef');
    expect(routeWorkspace('post this on the techember page', all)?.id).toBe('tef');
    expect(routeWorkspace('reply to the client from nexprove', all)?.id).toBe('nexprove');
    expect(routeWorkspace('forward it to sam@nexprove.com', all)?.id).toBe('nexprove');
    expect(routeWorkspace('Ellum investor update', all)?.id).toBe('ellum');
  });

  it('leaves it to the user when nothing or two things match', () => {
    expect(routeWorkspace('what is the weather', all)).toBeNull();
    expect(routeWorkspace('compare nexprove and ellum', all)).toBeNull();
    // Part of a word is not a mention
    expect(routeWorkspace('the bellum war', all)).toBeNull();
  });
});

describe('workspaceId', () => {
  it('makes a short unique id from a name', () => {
    expect(workspaceId('Tech Ember Fest!')).toBe('tech-ember-fest');
    expect(workspaceId('Nexprove', ['nexprove'])).toBe('nexprove-2');
  });
});

describe('workspaceForAccount', () => {
  it('finds the workspace of a Google account, by address or company domain', () => {
    const list = [
      ws('nexprove', 'Nexprove', [], 'avi@nexprove.com'),
      ws('personal', 'Personal', [], 'avi@gmail.com'),
      ws('tef', 'Tech Ember Fest', []),
    ];
    expect(workspaceForAccount('AVI@nexprove.com', list)?.id).toBe('nexprove');
    expect(workspaceForAccount('sam@nexprove.com', list)?.id).toBe('nexprove');
    expect(workspaceForAccount('avi@gmail.com', list)?.id).toBe('personal');
    // A public domain says nothing
    expect(workspaceForAccount('someone@gmail.com', list)).toBeNull();
    expect(workspaceForAccount('x@unknown.org', list)).toBeNull();
  });
});

// This block exercises the owner's own build (VITE_SEED_PROFILE=avi): three named workspaces,
// 'nexprove' default. See the 'neutral seed profile' block below for everyone else's build.
describe('workspaceStore default workspace (avi profile)', () => {
  beforeEach(() => {
    delete data.workspaces;
    vi.stubEnv('VITE_SEED_PROFILE', 'avi');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('seeds a brand-new install with its default already set', async () => {
    const items = await workspaceStore.list();
    expect(items.map(item => item.id)).toEqual(['nexprove', 'tech-ember-fest', 'ellum-ai']);
    expect(await workspaceStore.getDefaultWorkspaceId()).toBe('nexprove');
  });

  it('gives an install from before this field existed a default, once', async () => {
    // A pre-Wave-2 blob: seeded, with no defaultWorkspaceId or defaultWorkspaceMigrated key at all
    data.workspaces = {
      items: [{ id: 'nexprove', name: 'Nexprove', about: '', keywords: [], accounts: {}, createdAt: 0 }],
      seeded: true,
    };
    expect(await workspaceStore.getDefaultWorkspaceId()).toBe('nexprove');
  });

  it('never overwrites a default the user already chose or cleared', async () => {
    await workspaceStore.list();
    await workspaceStore.setDefaultWorkspaceId('ellum-ai');
    // Re-running the migration path (list/get again) must not reset it
    await workspaceStore.list();
    expect(await workspaceStore.getDefaultWorkspaceId()).toBe('ellum-ai');

    await workspaceStore.setDefaultWorkspaceId(null);
    await workspaceStore.list();
    expect(await workspaceStore.getDefaultWorkspaceId()).toBeNull();
  });

  it('clears the default when that workspace is removed, and leaves another default alone', async () => {
    await workspaceStore.list();
    await workspaceStore.setDefaultWorkspaceId('nexprove');
    await workspaceStore.remove('ellum-ai');
    expect(await workspaceStore.getDefaultWorkspaceId()).toBe('nexprove');

    await workspaceStore.remove('nexprove');
    expect(await workspaceStore.getDefaultWorkspaceId()).toBeNull();
  });
});

describe('activeSeedProfile', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is "avi" only when VITE_SEED_PROFILE is exactly "avi"', () => {
    vi.stubEnv('VITE_SEED_PROFILE', 'avi');
    expect(activeSeedProfile()).toBe('avi');
  });

  it('is "neutral" when unset, empty, or anything else — the public release build included', () => {
    vi.stubEnv('VITE_SEED_PROFILE', undefined);
    expect(activeSeedProfile()).toBe('neutral');
    vi.stubEnv('VITE_SEED_PROFILE', '');
    expect(activeSeedProfile()).toBe('neutral');
    vi.stubEnv('VITE_SEED_PROFILE', 'Avi');
    expect(activeSeedProfile()).toBe('neutral');
  });
});

// A build with no VITE_SEED_PROFILE=avi — everyone who is not the owner, including the public release
// zip (scripts/release.mjs builds from a clean worktree, which never carries a .env.local) — starts
// with one neutral, empty workspace instead of the owner's three.
describe('workspaceStore default workspace (neutral profile — everyone else)', () => {
  beforeEach(() => {
    delete data.workspaces;
    vi.stubEnv('VITE_SEED_PROFILE', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('seeds a brand-new install with exactly one empty workspace, already the default', async () => {
    const items = await workspaceStore.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'default', about: '', keywords: [], accounts: {} });
    expect(await workspaceStore.getDefaultWorkspaceId()).toBe('default');
  });

  it('carries none of the owner-profile workspaces', async () => {
    const items = await workspaceStore.list();
    expect(items.map(item => item.id)).not.toContain('nexprove');
    expect(items.map(item => item.id)).not.toContain('tech-ember-fest');
    expect(items.map(item => item.id)).not.toContain('ellum-ai');
  });

  it('gives an install from before this field existed a default, once, without adding the owner profile', async () => {
    // A pre-existing seeded install with no defaultWorkspaceId or defaultWorkspaceMigrated key at all
    data.workspaces = {
      items: [{ id: 'my-work', name: 'My Work', about: '', keywords: [], accounts: {}, createdAt: 0 }],
      seeded: true,
    };
    expect(await workspaceStore.getDefaultWorkspaceId()).toBe('default');
    // The migration only sets defaultWorkspaceId; it never seeds new items into an already-seeded state
    expect((await workspaceStore.list()).map(item => item.id)).toEqual(['my-work']);
  });

  it('is idempotent: re-seeding never duplicates the neutral workspace', async () => {
    await workspaceStore.list();
    await workspaceStore.list();
    const items = await workspaceStore.list();
    expect(items).toHaveLength(1);
  });

  it('never overwrites a default the user already chose or cleared', async () => {
    await workspaceStore.list();
    await workspaceStore.setDefaultWorkspaceId(null);
    await workspaceStore.list();
    expect(await workspaceStore.getDefaultWorkspaceId()).toBeNull();
  });
});
