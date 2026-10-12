import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const { DEFAULT_WORKSPACE_ID, workspaceStore } = await import('../workspaces');

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

describe('workspaceStore default workspace', () => {
  beforeEach(() => {
    delete data.workspaces;
  });

  it('seeds a brand-new install with its default already set', async () => {
    const items = await workspaceStore.list();
    expect(items.some(item => item.id === DEFAULT_WORKSPACE_ID)).toBe(true);
    expect(await workspaceStore.getDefaultWorkspaceId()).toBe(DEFAULT_WORKSPACE_ID);
  });

  it('gives an install from before this field existed a default, once', async () => {
    // A pre-Wave-2 blob: seeded, with no defaultWorkspaceId or defaultWorkspaceMigrated key at all
    data.workspaces = {
      items: [{ id: 'nexprove', name: 'Nexprove', about: '', keywords: [], accounts: {}, createdAt: 0 }],
      seeded: true,
    };
    expect(await workspaceStore.getDefaultWorkspaceId()).toBe(DEFAULT_WORKSPACE_ID);
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
