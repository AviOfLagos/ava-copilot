import { createLogger } from '../log';

const logger = createLogger('TabPanels');

/** Where the tab → chat map lives: session storage, because tab ids only mean something until the browser closes. */
export const TAB_PANELS_KEY = 'tab-panels';

/**
 * What a tab's panel shows. `home` is the tab the user opened the chat on; `work` is a tab the chat's run opened
 * or took for its work, which shows the same chat when the user opens Ava there.
 */
export interface TabPanelEntry {
  threadId: string;
  role: 'home' | 'work';
}

export type TabPanelMap = Record<string, TabPanelEntry>;

export interface TabPanelDeps {
  read: () => Promise<TabPanelMap>;
  write: (map: TabPanelMap) => Promise<void>;
  // Turns the side panel on for one tab, showing that tab's own page of the panel
  enable: (tabId: number) => Promise<void>;
  disable: (tabId: number) => Promise<void>;
}

/** The panel page of one tab: it knows its tab from the address, and keeps its own chat, draft and scroll. */
export function panelPathFor(tabId: number): string {
  return `sidepanel.html?tab=${tabId}`;
}

const chromeDeps = (): TabPanelDeps => ({
  read: async () => ((await chrome.storage.session.get(TAB_PANELS_KEY))[TAB_PANELS_KEY] as TabPanelMap) ?? {},
  write: map => chrome.storage.session.set({ [TAB_PANELS_KEY]: map }),
  enable: tabId => chrome.sidePanel.setOptions({ tabId, path: panelPathFor(tabId), enabled: true }),
  disable: tabId => chrome.sidePanel.setOptions({ tabId, enabled: false }),
});

/**
 * Which chat each tab's side panel shows. The panel is per tab: Ava opened on a tab shows on that tab only, and a
 * tab with no chat of its own shows no panel. One chat lives on one home tab at a time; opening it on another tab
 * moves it there. The map is mirrored in memory so the thread manager can ask synchronously whose tab a tab is.
 */
export class TabPanels {
  private map: TabPanelMap = {};
  private loaded: Promise<void> | null = null;
  // One change at a time: two writes racing would lose one of them
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: TabPanelDeps = chromeDeps()) {}

  /** Reads the stored map once; every other method waits for it. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        this.map = { ...(await this.deps.read()), ...this.map };
      } catch (error) {
        logger.warning('Could not read the tab panels', error);
      }
    })();
    return this.loaded;
  }

  private change<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(async () => {
      await this.load();
      return fn();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async save(): Promise<void> {
    try {
      await this.deps.write({ ...this.map });
    } catch (error) {
      logger.warning('Could not save the tab panels', error);
    }
  }

  /** The chat a tab's panel shows, if any. Synchronous: from the in-memory copy. */
  entryOf(tabId: number): TabPanelEntry | null {
    return this.map[String(tabId)] ?? null;
  }

  /** The tab a chat lives on, if any. */
  homeOf(threadId: string): number | null {
    for (const [tabId, entry] of Object.entries(this.map)) {
      if (entry.threadId === threadId && entry.role === 'home') return Number(tabId);
    }
    return null;
  }

  /**
   * Whether a chat may act on a tab: a tab that is another chat's home or work tab is that chat's, and no other
   * chat drives it.
   */
  mayUse(threadId: string, tabId: number): boolean {
    const entry = this.entryOf(tabId);
    return !entry || entry.threadId === threadId;
  }

  /** Turns the panel on for a tab, e.g. when the user clicks Ava there. Does not change what it shows. */
  async enable(tabId: number): Promise<void> {
    try {
      await this.deps.enable(tabId);
    } catch (error) {
      logger.warning('Could not enable the panel', error);
    }
  }

  /**
   * Makes a tab the home of a chat: its panel shows the chat from now on. The chat leaves every other tab it was
   * the home of, and the tab's previous chat (if any) loses it.
   *
   * @returns The tab the chat lived on before, if it was another one
   */
  open(tabId: number, threadId: string): Promise<number | null> {
    return this.change(async () => {
      let previous: number | null = null;
      for (const [key, entry] of Object.entries(this.map)) {
        if (entry.threadId === threadId && entry.role === 'home' && Number(key) !== tabId) {
          previous = Number(key);
          delete this.map[key];
        }
      }
      this.map[String(tabId)] = { threadId, role: 'home' };
      await this.save();
      return previous;
    });
  }

  /** A tab's panel goes back to the start screen ("New conversation" or a past one). */
  clear(tabId: number): Promise<void> {
    return this.change(async () => {
      if (!this.map[String(tabId)]) return;
      delete this.map[String(tabId)];
      await this.save();
    });
  }

  /**
   * A tab a chat's run opened or took: opening Ava there shows the same chat. A tab that already belongs to a chat
   * keeps its own.
   */
  addWork(tabId: number, threadId: string): Promise<boolean> {
    return this.change(async () => {
      if (this.map[String(tabId)]) return false;
      this.map[String(tabId)] = { threadId, role: 'work' };
      await this.save();
      await this.enable(tabId);
      return true;
    });
  }

  /** A tab closed: it shows nothing any more. */
  forgetTab(tabId: number): Promise<void> {
    return this.clear(tabId);
  }

  /** A chat was deleted: every tab that showed it goes back to the start screen. */
  forgetThread(threadId: string): Promise<void> {
    return this.change(async () => {
      let changed = false;
      for (const [key, entry] of Object.entries(this.map)) {
        if (entry.threadId === threadId) {
          delete this.map[key];
          changed = true;
        }
      }
      if (changed) await this.save();
    });
  }
}

export const tabPanels = new TabPanels();

/**
 * Opens the side panel on one tab, for that tab only. Must run inside the user's click (Chrome only opens the
 * panel from a user gesture), so nothing is awaited before `open`: Chrome handles the two calls in order.
 */
export function openPanelOnTab(tabId: number): Promise<void> {
  const enabled = chrome.sidePanel.setOptions({ tabId, path: panelPathFor(tabId), enabled: true });
  const opened = chrome.sidePanel.open({ tabId });
  return Promise.all([enabled, opened]).then(() => undefined);
}

/** Opens the panel on the tab in front of a window: for callers that only know the window (a notification). */
export async function openPanelInWindow(windowId: number): Promise<void> {
  const [tab] = await chrome.tabs.query({ windowId, active: true });
  if (tab?.id !== undefined) await openPanelOnTab(tab.id);
  else await chrome.sidePanel.open({ windowId });
}
