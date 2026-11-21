import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupTabs, TabBinding, tabsToBind } from '../binding';

interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  active: boolean;
  incognito: boolean;
  groupId: number;
  highlighted?: boolean;
  lastAccessed?: number;
}

let tabs: FakeTab[];
let grouped: number[][];

const tab = (over: Partial<FakeTab> & { id: number }): FakeTab => ({
  windowId: 1,
  url: 'https://news.example/',
  active: false,
  incognito: false,
  groupId: -1,
  ...over,
});

beforeEach(() => {
  tabs = [];
  grouped = [];
  vi.stubGlobal('chrome', {
    tabGroups: { TAB_GROUP_ID_NONE: -1, update: async () => ({}) },
    windows: {
      get: async (id: number) => ({ id, type: 'normal' }),
      getLastFocused: async () => ({ id: 1, type: 'normal' }),
    },
    tabs: {
      get: async (id: number) => {
        const found = tabs.find(item => item.id === id);
        if (!found) throw new Error('No tab');
        return found;
      },
      query: async (q: { windowId?: number; active?: boolean; highlighted?: boolean; groupId?: number }) =>
        tabs.filter(
          item =>
            (q.windowId === undefined || item.windowId === q.windowId) &&
            (q.active === undefined || item.active === q.active) &&
            (q.highlighted === undefined || (item.highlighted ?? item.active) === q.highlighted) &&
            (q.groupId === undefined || item.groupId === q.groupId),
        ),
      group: async ({ tabIds }: { tabIds: number[] }) => {
        grouped.push(tabIds);
        return 7;
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const hint = (site: string, ...ids: number[]) => ({ site, usable: (item: chrome.tabs.Tab) => ids.includes(item.id!) });

describe('tabsToBind with a site hint', () => {
  it('takes the open tab on that site from another window, the one used last', async () => {
    tabs = [
      tab({ id: 1, active: true }),
      tab({ id: 2, windowId: 2, url: 'https://www.facebook.com/a', lastAccessed: 10 }),
      tab({ id: 3, windowId: 3, url: 'https://www.facebook.com/b', lastAccessed: 20 }),
    ];
    expect(await tabsToBind(1, hint('facebook.com', 2, 3))).toEqual({
      tabIds: [3],
      groupId: null,
      reusedSite: 'facebook.com',
    });
  });

  it('keeps to the tab in front when it is on that site already', async () => {
    tabs = [
      tab({ id: 1, active: true, url: 'https://www.facebook.com/' }),
      tab({ id: 2, windowId: 2, url: 'https://www.facebook.com/a' }),
    ];
    expect(await tabsToBind(1, hint('facebook.com', 1, 2))).toEqual({ tabIds: [1], groupId: null });
  });

  it('never takes a private tab, one the hint does not allow, or another part of the same domain', async () => {
    tabs = [
      tab({ id: 1, active: true }),
      tab({ id: 2, windowId: 2, url: 'https://www.facebook.com/a', incognito: true }),
      tab({ id: 3, windowId: 2, url: 'https://www.facebook.com/b' }),
      tab({ id: 4, windowId: 2, url: 'https://business.facebook.com/' }),
    ];
    // Tab 3 is held by another task (not usable); tab 4 is another product
    expect(await tabsToBind(1, hint('facebook.com', 2, 4))).toEqual({ tabIds: [1], groupId: null });
  });

  it('falls back to the rule without a hint: the tab in front, or its whole group', async () => {
    tabs = [tab({ id: 1, active: true, groupId: 5 }), tab({ id: 2, groupId: 5 }), tab({ id: 3 })];
    expect(await tabsToBind(1)).toEqual({ tabIds: [1, 2], groupId: 5 });
  });
});

describe('groupTabs', () => {
  it('groups only the tabs in the first tab’s window, so a tab taken over elsewhere is not moved', async () => {
    tabs = [tab({ id: 1 }), tab({ id: 2 }), tab({ id: 3, windowId: 2 })];
    const binding = new TabBinding([1, 2, 3]);
    expect(await groupTabs(binding, 'Task')).toBe(7);
    expect(grouped).toEqual([[1, 2]]);
  });

  it('groups nothing when the only other tab is in another window', async () => {
    tabs = [tab({ id: 1 }), tab({ id: 3, windowId: 2 })];
    const binding = new TabBinding([1, 3]);
    expect(await groupTabs(binding, 'Task')).toBeNull();
    expect(grouped).toEqual([]);
  });
});
