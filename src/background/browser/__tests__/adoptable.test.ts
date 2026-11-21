import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabBinding } from '../../threads/binding';

// The browser context loads the extension polyfill, which needs an extension to be there
vi.hoisted(() => vi.stubGlobal('chrome', { runtime: { id: 'test' } }));
vi.mock('webextension-polyfill', () => ({ default: {} }));
vi.mock('../page', () => ({ default: class {}, build_initial_state: () => ({}) }));

const { default: BrowserContext } = await import('../context');
const { tabRegistry } = await import('../tabRegistry');

interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  title: string;
  incognito: boolean;
}
let tabs: FakeTab[];
const windows: Record<number, { type: string; incognito: boolean }> = {
  1: { type: 'normal', incognito: false },
  2: { type: 'normal', incognito: false },
  3: { type: 'normal', incognito: true },
  4: { type: 'popup', incognito: false },
  // The agents' own window
  5: { type: 'normal', incognito: false },
};
const tab = (id: number, windowId: number, url = `https://site${id}.example/`): FakeTab => ({
  id,
  windowId,
  url,
  title: `Site ${id}`,
  incognito: windows[windowId]!.incognito,
});

beforeEach(() => {
  tabs = [tab(1, 1), tab(2, 1), tab(3, 2), tab(4, 3), tab(5, 4), tab(6, 5), tab(7, 2, 'https://blocked.example/')];
  vi.stubGlobal('chrome', {
    runtime: { id: 'test' },
    tabs: {
      get: async (id: number) => {
        const found = tabs.find(item => item.id === id);
        if (!found) throw new Error('No tab');
        return found;
      },
      query: async () => tabs,
    },
    windows: {
      get: async (id: number) => {
        if (!windows[id]) throw new Error('No window');
        return { id, ...windows[id] };
      },
    },
  });
  tabRegistry.deps = { isOffLimits: async windowId => windowId === 5 };
});
afterEach(() => {
  tabRegistry.deps = {};
});

function contextFor(binding: TabBinding) {
  const context = new BrowserContext({ deniedUrls: ['blocked.example'] });
  context.setBinding(binding);
  return context;
}
const available = async (context: InstanceType<typeof BrowserContext>) =>
  (await context.getTabInfos()).map(info => info.id).sort();

describe('which tabs a task may take over', () => {
  it("a person's task may take a free tab from any ordinary window, and nothing else", async () => {
    const binding = new TabBinding([1]);
    binding.anyWindow = true;
    binding.canAdopt = tabId => tabId !== 2;
    // Not 2 (another task holds it), 4 (private), 5 (a pop-up), 6 (the agents' window), 7 (the firewall)
    expect(await available(contextFor(binding))).toEqual([1, 3]);
    expect(contextFor(binding).roams).toBe(true);
  });

  it("an agent's run stays in the windows it already works in", async () => {
    const binding = new TabBinding([1]);
    binding.canAdopt = () => true;
    expect(await available(contextFor(binding))).toEqual([1, 2]);
    expect(contextFor(binding).roams).toBe(false);
  });

  it('refuses a switch to a tab it may not take, and allows one it may', async () => {
    const binding = new TabBinding([1]);
    binding.anyWindow = true;
    binding.canAdopt = () => true;
    const context = contextFor(binding);
    await expect(context.switchTab(4)).rejects.toThrow(/not bound/);
    await expect(context.switchTab(6)).rejects.toThrow(/not bound/);
    await expect(context.switchTab(7)).rejects.toThrow(/not bound/);
    expect(binding.has(4) || binding.has(6) || binding.has(7)).toBe(false);
  });
});
