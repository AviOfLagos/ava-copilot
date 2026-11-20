import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ageText, hostOf, matchTabs, onSite, siteLines, TabRegistry } from '../tabRegistry';
import type { ListedTab } from '../tabRegistry';

type Listener = (...args: never[]) => void;
const event = () => {
  const listeners: Listener[] = [];
  return {
    addListener: (listener: Listener) => listeners.push(listener),
    fire: (...args: unknown[]) => listeners.forEach(listener => (listener as (...a: unknown[]) => void)(...args)),
  };
};

interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  incognito: boolean;
  lastAccessed?: number;
}

function fakeChrome() {
  const tabs = new Map<number, FakeTab>();
  const windows = new Map<number, { id: number; type: string; incognito: boolean }>();
  const session: Record<string, unknown> = {};
  const api = {
    tabs: {
      onCreated: event(),
      onUpdated: event(),
      onActivated: event(),
      onRemoved: event(),
      onAttached: event(),
      onReplaced: event(),
      get: async (id: number) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error('No tab');
        return tab;
      },
      query: async (filter: { windowType?: string }) =>
        [...tabs.values()].filter(tab => !filter.windowType || windows.get(tab.windowId)?.type === filter.windowType),
    },
    windows: {
      onRemoved: event(),
      get: async (id: number) => {
        const window = windows.get(id);
        if (!window) throw new Error('No window');
        return window;
      },
    },
    storage: {
      session: {
        get: async (key: string) => ({ [key]: session[key] }),
        set: async (items: Record<string, unknown>) => void Object.assign(session, structuredClone(items)),
      },
    },
  };
  return { api, tabs, windows, session };
}

const MINUTE = 60_000;
let fake: ReturnType<typeof fakeChrome>;
let clock: number;

function open(tab: Partial<FakeTab> & { id: number }): FakeTab {
  const full: FakeTab = {
    windowId: 1,
    url: 'https://example.com/',
    title: 'Example',
    active: false,
    incognito: false,
    ...tab,
  };
  fake.tabs.set(full.id, full);
  fake.api.tabs.onCreated.fire(full);
  return full;
}

beforeEach(() => {
  fake = fakeChrome();
  fake.windows.set(1, { id: 1, type: 'normal', incognito: false });
  fake.windows.set(2, { id: 2, type: 'normal', incognito: false });
  clock = 1_000_000_000;
  vi.stubGlobal('chrome', fake.api);
});
afterEach(() => vi.unstubAllGlobals());

const registry = (deps = {}) => {
  const made = new TabRegistry({ now: () => clock, ...deps });
  made.listen();
  return made;
};

describe('helpers', () => {
  it('reads the site of an address', () => {
    expect(hostOf('https://www.facebook.com/me')).toBe('facebook.com');
    expect(hostOf('chrome://extensions')).toBe('');
    expect(hostOf(undefined)).toBe('');
  });

  it('says an age in a few words', () => {
    expect(ageText(20 * 1000)).toBe('under 1 min');
    expect(ageText(20 * MINUTE)).toBe('20 min');
    expect(ageText(3 * 60 * MINUTE)).toBe('3 h');
    expect(ageText(72 * 60 * MINUTE)).toBe('3 d');
  });

  it('knows a part of a site from another site', () => {
    expect(onSite('app.slack.com', 'slack.com')).toBe(true);
    expect(onSite('notslack.com', 'slack.com')).toBe(false);
    expect(onSite('', 'slack.com')).toBe(false);
  });
});

describe('TabRegistry', () => {
  it('records when a tab opened and when it was last in front', async () => {
    const tabs = registry();
    open({ id: 1, url: 'https://www.facebook.com/', title: 'Facebook', active: true });
    clock += 3 * 60 * MINUTE;
    open({ id: 2, url: 'https://app.slack.com/client', title: 'Slack' });
    // The user moves from Facebook to Slack, and stays there twenty minutes
    fake.tabs.get(1)!.active = false;
    fake.tabs.get(2)!.active = true;
    fake.api.tabs.onActivated.fire({ tabId: 2, windowId: 1 });
    const switchedAt = clock;
    clock += 20 * MINUTE;

    const listed = await tabs.list();
    expect(listed.map(tab => tab.host)).toEqual(['app.slack.com', 'facebook.com']);
    const facebook = listed[1]!;
    expect(clock - facebook.openedAt).toBe(3 * 60 * MINUTE + 20 * MINUTE);
    expect(facebook.lastActiveAt).toBe(switchedAt);
    expect(siteLines(listed, clock)).toEqual([
      'app.slack.com: 1 tab, open 20 min, in front now',
      'facebook.com: 1 tab, open 3 h, last used 20 min ago',
    ]);
  });

  it('follows a tab to a new address and forgets it when it closes', async () => {
    const tabs = registry();
    const tab = open({ id: 1, url: 'https://example.com/', title: 'Example' });
    const openedAt = clock;
    clock += 5 * MINUTE;
    Object.assign(tab, { url: 'https://trysuture.com/pricing', title: 'Pricing' });
    fake.api.tabs.onUpdated.fire(1, { url: tab.url }, tab);
    expect(await tabs.list()).toMatchObject([{ id: 1, host: 'trysuture.com', title: 'Pricing', openedAt }]);

    fake.tabs.delete(1);
    fake.api.tabs.onRemoved.fire(1);
    expect(await tabs.list()).toEqual([]);
  });

  it('never lists a private window, a pop-up window, or a page that is not on the web', async () => {
    const tabs = registry();
    fake.windows.set(3, { id: 3, type: 'popup', incognito: false });
    open({ id: 1, url: 'https://secret.example/', incognito: true });
    open({ id: 2, url: 'chrome://settings/' });
    open({ id: 3, url: 'https://popup.example/', windowId: 3 });
    open({ id: 4, url: 'https://fine.example/' });
    expect((await tabs.list()).map(tab => tab.id)).toEqual([4]);
    await tabs.flushed();
    // Nothing about the private tab is stored either
    expect(JSON.stringify(fake.session)).not.toContain('secret.example');
  });

  it('leaves out a window that is off limits, and says so for reuse', async () => {
    const tabs = registry({ isOffLimits: async (windowId: number) => windowId === 2 });
    open({ id: 1, url: 'https://a.example/' });
    open({ id: 2, url: 'https://b.example/', windowId: 2 });
    expect((await tabs.list()).map(tab => tab.id)).toEqual([1]);
    expect(await tabs.reusableWindow(1)).toBe(true);
    expect(await tabs.reusableWindow(2)).toBe(false);
    expect(await tabs.reusableWindow(99)).toBe(false);
  });

  it('says which task holds a tab', async () => {
    const tabs = registry({ holderOf: (tabId: number) => (tabId === 2 ? 'thread-b' : null) });
    open({ id: 1, url: 'https://a.example/' });
    open({ id: 2, url: 'https://a.example/inbox' });
    const listed = await tabs.list();
    expect(listed.find(tab => tab.id === 2)?.heldBy).toBe('thread-b');
    expect(siteLines(listed, clock)).toEqual([
      'a.example: 2 tabs, open under 1 min, last used under 1 min ago (1 busy)',
    ]);
    // The task that holds it does not see its own tab as busy
    expect(siteLines(listed, clock, 'thread-b')[0]).not.toContain('busy');
  });

  it('keeps the times across a restart of the background, and drops tabs that closed meanwhile', async () => {
    const first = registry();
    open({ id: 1, url: 'https://a.example/' });
    open({ id: 2, url: 'https://b.example/' });
    const openedAt = clock;
    await first.flushed();

    clock += 60 * MINUTE;
    fake.tabs.delete(2);
    const second = registry();
    const listed = await second.list();
    expect(listed).toMatchObject([{ id: 1, openedAt }]);
    await second.flushed();
    expect(JSON.stringify(fake.session)).not.toContain('b.example');
  });

  it('forgets every tab of a window that closes', async () => {
    const tabs = registry();
    open({ id: 1, url: 'https://a.example/', windowId: 2 });
    open({ id: 2, url: 'https://b.example/', windowId: 2 });
    fake.tabs.clear();
    fake.api.windows.onRemoved.fire(2);
    await tabs.flushed();
    expect(fake.session['tab-registry']).toEqual([]);
  });

  it("falls back on the browser's own last-used time for a tab it never saw", async () => {
    const tabs = new TabRegistry({ now: () => clock });
    fake.tabs.set(7, {
      id: 7,
      windowId: 1,
      url: 'https://old.example/',
      title: 'Old',
      active: false,
      incognito: false,
      lastAccessed: clock - 90 * MINUTE,
    });
    const [tab] = await tabs.list();
    expect(tab).toMatchObject({ id: 7, lastActiveAt: clock - 90 * MINUTE, openedAt: clock - 90 * MINUTE });
  });
});

describe('matchTabs and siteLines', () => {
  const tab = (over: Partial<ListedTab>): ListedTab => ({
    id: 1,
    windowId: 1,
    url: 'https://example.com/',
    host: 'example.com',
    title: 'Example',
    openedAt: 0,
    lastActiveAt: 0,
    active: false,
    heldBy: null,
    ...over,
  });

  it('matches by site, by title words and by address', () => {
    const tabs = [
      tab({ id: 1, host: 'facebook.com', url: 'https://www.facebook.com/messages', title: 'Messenger' }),
      tab({ id: 2, host: 'trysuture.com', url: 'https://trysuture.com/pricing', title: 'Pricing | Suture' }),
    ];
    expect(matchTabs(tabs, 'facebook').map(found => found.id)).toEqual([1]);
    expect(matchTabs(tabs, 'https://www.facebook.com').map(found => found.id)).toEqual([1]);
    expect(matchTabs(tabs, 'suture pricing').map(found => found.id)).toEqual([2]);
    expect(matchTabs(tabs, 'suture billing')).toEqual([]);
    expect(matchTabs(tabs, '   ')).toEqual([]);
  });

  it('keeps to the line limit and says how many sites are left out', () => {
    const tabs = Array.from({ length: 40 }, (_, index) =>
      tab({ id: index, host: `site${index}.example`, lastActiveAt: index }),
    );
    const lines = siteLines(tabs, 100, null, 30);
    expect(lines).toHaveLength(30);
    expect(lines[0]).toContain('site39.example');
    expect(lines[29]).toBe('and 11 more sites (find_tab finds them)');
  });
});
