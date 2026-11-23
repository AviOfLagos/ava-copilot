import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asksForThisTab, groupTabs, siteOf, TabBinding, tabsToBind } from '../binding';

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

describe('keeping the user’s page (new tab for another site)', () => {
  const Binding = TabBinding;

  it('tells the site of a host, so a subdomain is the same site and another domain is not', () => {
    expect(siteOf('mail.google.com')).toBe('google.com');
    expect(siteOf('google.com')).toBe('google.com');
    expect(siteOf('shop.example.co.uk')).toBe('example.co.uk');
    expect(siteOf('jumia.com.ng')).toBe('jumia.com.ng');
    expect(siteOf('localhost')).toBe('localhost');
    expect(siteOf('127.0.0.1')).toBe('127.0.0.1');
    expect(siteOf('')).toBe('');
  });

  it('sends a step that would take the user’s page to another site to a new tab', () => {
    const binding = new Binding([1, 2]);
    binding.userTabs.add(1);
    expect(binding.keepsPage(1, 'https://news.example/today', 'https://www.reddit.com/r/x')).toBe(true);
    // The same site, a subdomain of it, or a page of the user's that is blank: navigated as asked
    expect(binding.keepsPage(1, 'https://news.example/today', 'https://news.example/sport')).toBe(false);
    expect(binding.keepsPage(1, 'https://news.example/', 'https://live.news.example/')).toBe(false);
    expect(binding.keepsPage(1, 'chrome://newtab/', 'https://www.reddit.com/')).toBe(false);
    // A tab the run opened itself goes wherever the task needs
    expect(binding.keepsPage(2, 'https://news.example/', 'https://www.reddit.com/')).toBe(false);
    expect(binding.keepsPage(null, 'https://news.example/', 'https://www.reddit.com/')).toBe(false);
  });

  it('counts a free tab of the user’s that the run took over as the user’s page, and a tab it opened as its own', () => {
    const binding = new Binding([1]);
    binding.add(5, false);
    binding.add(6);
    expect(binding.userTabs.has(5)).toBe(true);
    expect(binding.userTabs.has(6)).toBe(false);
    binding.remove(5);
    expect(binding.userTabs.has(5)).toBe(false);
  });

  it('hears the user ask to stay in this tab', () => {
    expect(asksForThisTab('Open reddit in this tab')).toBe(true);
    expect(asksForThisTab('use the current tab to go to gmail')).toBe(true);
    expect(asksForThisTab('do it in the same tab please')).toBe(true);
    expect(asksForThisTab('Go to reddit and find the launch thread')).toBe(false);
    expect(asksForThisTab('Summarise this page')).toBe(false);
    // Mentioning the tab is not asking to leave it for another site
    expect(asksForThisTab('summarize this tab, then compare on amazon.com')).toBe(false);
    expect(asksForThisTab("what's on this tab")).toBe(false);
  });
});
