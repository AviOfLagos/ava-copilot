import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TabBinding } from '../../threads/binding';

// The browser context loads the extension polyfill, which needs an extension to be there
vi.hoisted(() => vi.stubGlobal('chrome', { runtime: { id: 'test' } }));
vi.mock('webextension-polyfill', () => ({ default: {} }));
vi.mock('../page', () => ({ default: class {}, build_initial_state: () => ({}) }));

const { default: BrowserContext } = await import('../context');

const tabs: Record<number, { id: number; url: string; windowId: number }> = {};
const updated: { tabId: number; url?: string }[] = [];

beforeEach(() => {
  for (const key of Object.keys(tabs)) delete tabs[Number(key)];
  updated.length = 0;
  tabs[1] = { id: 1, url: 'https://news.example/today', windowId: 1 };
  tabs[2] = { id: 2, url: 'https://shop.example/', windowId: 1 };
  vi.stubGlobal('chrome', {
    runtime: { id: 'test' },
    tabs: {
      get: async (id: number) => {
        if (!tabs[id]) throw new Error('No tab');
        return tabs[id];
      },
      update: async (tabId: number, change: { url?: string }) => void updated.push({ tabId, ...change }),
    },
  });
});

/** A context working in tab 1, with going to a page and opening a tab recorded instead of done. */
function contextOn(binding: TabBinding) {
  const context = new BrowserContext({});
  context.setBinding(binding);
  const opened: string[] = [];
  const navigated: string[] = [];
  vi.spyOn(context, 'openTab').mockImplementation(async url => {
    opened.push(url);
    return {} as never;
  });
  vi.spyOn(context, 'getCurrentPage').mockImplementation(
    async () =>
      ({
        attached: true,
        tabId: context.currentTabId,
        navigateTo: async (url: string) => void navigated.push(url),
      }) as never,
  );
  return { context, opened, navigated };
}

describe('go to a page from the user’s tab', () => {
  it('opens another site in a new tab and leaves the user’s page as it was', async () => {
    const binding = new TabBinding([1]);
    binding.userTabs.add(1);
    const { context, opened, navigated } = contextOn(binding);
    expect(await context.navigateTo('https://www.reddit.com/r/launch')).toBe('new_tab');
    expect(opened).toEqual(['https://www.reddit.com/r/launch']);
    expect(navigated).toEqual([]);
  });

  it('goes to another page of the same site in the same tab', async () => {
    const binding = new TabBinding([1]);
    binding.userTabs.add(1);
    const { context, opened, navigated } = contextOn(binding);
    expect(await context.navigateTo('https://news.example/sport')).toBeUndefined();
    expect(opened).toEqual([]);
    expect(navigated).toEqual(['https://news.example/sport']);
  });

  it('goes anywhere in the tab when the user said to use it (no user tabs)', async () => {
    const { context, opened, navigated } = contextOn(new TabBinding([1]));
    await context.navigateTo('https://www.reddit.com/');
    expect(opened).toEqual([]);
    expect(navigated).toEqual(['https://www.reddit.com/']);
  });
});
