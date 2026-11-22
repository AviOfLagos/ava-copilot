import { createLogger } from '../log';

/**
 * What Ava knows about the tabs that are open: where each one is, when it was opened and when it was last in
 * front. Chrome can list tabs, but not their age, so the times are kept here, fed by the tab events and stored in
 * session storage (a restarted background keeps them; a restarted browser starts again).
 *
 * Reads never trust the stored copy alone: `list()` asks Chrome which tabs exist now and adds the times to
 * them, so a missed event can make an age wrong but never lists a tab that is gone.
 */

const logger = createLogger('TabRegistry');

const STATE_KEY = 'tab-registry';
const URL_MAX = 2000;
const TITLE_MAX = 200;

export interface TabEntry {
  id: number;
  windowId: number;
  url: string;
  // The site, without "www."
  host: string;
  title: string;
  openedAt: number;
  lastActiveAt: number;
}

export interface ListedTab extends TabEntry {
  // In front in its window now
  active: boolean;
  // The running task that holds it, if any
  heldBy: string | null;
}

export interface TabRegistryDeps {
  // The running task that holds a tab
  holderOf?: (tabId: number) => string | null;
  // Windows whose tabs are never offered for reuse (the agents' own window)
  isOffLimits?: (windowId: number) => Promise<boolean>;
  now?: () => number;
}

/** The site of a web address, without "www."; empty for anything that is not a web page. */
export function hostOf(url: string | undefined): string {
  if (!url || !/^https?:/i.test(url)) return '';
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** A length of time in a few words: "5 min", "3 h", "2 d". */
export function ageText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'under 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

export class TabRegistry {
  private entries = new Map<number, TabEntry>();
  private loaded: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;
  private listening = false;
  deps: TabRegistryDeps;

  constructor(deps: TabRegistryDeps = {}) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Reads what a restarted background left in session storage. Safe to call often. */
  ready(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const items: Record<string, unknown> = await chrome.storage.session.get(STATE_KEY);
        const stored = items[STATE_KEY];
        if (!Array.isArray(stored)) return;
        for (const entry of stored as TabEntry[]) {
          // Events that arrived before the read are newer than the stored copy
          if (typeof entry?.id === 'number' && !this.entries.has(entry.id)) this.entries.set(entry.id, entry);
        }
      } catch (error) {
        logger.warning('Could not read the tab registry', error);
      }
    })();
    return this.loaded;
  }

  // One write at a time; changes that arrive during a write go out in the next one
  private save(): void {
    if (this.dirty) return;
    this.dirty = true;
    this.saving = this.saving
      .then(() => this.ready())
      .then(() => {
        this.dirty = false;
        return chrome.storage.session.set({ [STATE_KEY]: [...this.entries.values()] });
      })
      .catch(error => logger.warning('Could not save the tab registry', error));
  }

  /** Resolves when everything recorded so far is stored (for tests and before a read after a burst). */
  flushed(): Promise<void> {
    return this.saving;
  }

  /** Starts following the browser's tab events. Must run in the background's first tick. */
  listen(): void {
    if (this.listening) return;
    this.listening = true;
    chrome.tabs.onCreated.addListener(tab => this.onCreated(tab));
    chrome.tabs.onUpdated.addListener((_tabId, _change, tab) => this.onUpdated(tab));
    chrome.tabs.onActivated.addListener(info => this.onActivated(info.tabId, info.windowId));
    chrome.tabs.onRemoved.addListener(tabId => this.onRemoved(tabId));
    chrome.tabs.onAttached?.addListener((tabId, info) => this.onMoved(tabId, info.newWindowId));
    chrome.tabs.onReplaced?.addListener((addedTabId, removedTabId) => this.onReplaced(addedTabId, removedTabId));
    chrome.windows.onRemoved.addListener(windowId => this.onWindowRemoved(windowId));
    void this.ready();
  }

  // A private window's tabs are never recorded
  private record(tab: chrome.tabs.Tab, fresh: boolean): void {
    if (tab.id === undefined || tab.incognito) return;
    const now = this.now();
    const before = this.entries.get(tab.id);
    const seen = (tab as { lastAccessed?: number }).lastAccessed;
    if (tab.active) this.front.set(tab.windowId, tab.id);
    this.entries.set(tab.id, {
      id: tab.id,
      windowId: tab.windowId,
      url: (tab.url ?? before?.url ?? '').slice(0, URL_MAX),
      host: hostOf(tab.url ?? before?.url),
      title: (tab.title ?? before?.title ?? '').slice(0, TITLE_MAX),
      // A tab first seen long after it opened (the browser was already running): its last use is the best guess
      openedAt: before?.openedAt ?? (fresh ? now : Math.min(now, seen ?? now)),
      lastActiveAt: tab.active ? now : (before?.lastActiveAt ?? Math.min(now, seen ?? now)),
    });
    this.save();
  }

  onCreated(tab: chrome.tabs.Tab): void {
    this.record(tab, true);
  }

  onUpdated(tab: chrome.tabs.Tab): void {
    this.record(tab, false);
  }

  // The tab in front of each window, so the one that leaves the front is marked as used until then
  private front = new Map<number, number>();

  onActivated(tabId: number, windowId: number): void {
    const now = this.now();
    const previous = this.front.get(windowId);
    const left = previous !== undefined && previous !== tabId ? this.entries.get(previous) : undefined;
    if (left) left.lastActiveAt = now;
    this.front.set(windowId, tabId);
    const entry = this.entries.get(tabId);
    if (entry) {
      entry.lastActiveAt = now;
      entry.windowId = windowId;
      this.save();
      return;
    }
    // Activated before it was ever seen: read it from the browser
    void chrome.tabs.get(tabId).then(
      tab => this.record({ ...tab, active: true }, false),
      () => {},
    );
  }

  onMoved(tabId: number, windowId: number): void {
    const entry = this.entries.get(tabId);
    if (!entry) return;
    entry.windowId = windowId;
    this.save();
  }

  onReplaced(addedTabId: number, removedTabId: number): void {
    const entry = this.entries.get(removedTabId);
    this.entries.delete(removedTabId);
    if (entry) this.entries.set(addedTabId, { ...entry, id: addedTabId });
    this.save();
  }

  onRemoved(tabId: number): void {
    if (this.entries.delete(tabId)) this.save();
  }

  onWindowRemoved(windowId: number): void {
    let changed = false;
    for (const entry of [...this.entries.values()]) {
      if (entry.windowId === windowId) changed = this.entries.delete(entry.id) || changed;
    }
    this.front.delete(windowId);
    if (changed) this.save();
  }

  /**
   * Whether a window's tabs may be offered for reuse: an ordinary browser window, not private, and not one that
   * is off limits (the agents' own window).
   */
  async reusableWindow(windowId: number | undefined): Promise<boolean> {
    if (windowId === undefined) return false;
    const window = await chrome.windows.get(windowId).catch(() => undefined);
    if (!window || window.type !== 'normal' || window.incognito) return false;
    return !(await this.deps.isOffLimits?.(windowId).catch(() => false));
  }

  /**
   * Every web page open in an ordinary window, most recently used first. Private windows are never listed, and
   * neither are windows that are off limits.
   */
  async list(): Promise<ListedTab[]> {
    await this.ready();
    const tabs = await chrome.tabs.query({ windowType: 'normal' });
    const now = this.now();
    const offLimits = new Map<number, boolean>();
    const listed: ListedTab[] = [];
    const live = new Set<number>();
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      live.add(tab.id);
      const host = hostOf(tab.url);
      if (tab.incognito || !host) continue;
      if (!offLimits.has(tab.windowId)) {
        offLimits.set(tab.windowId, (await this.deps.isOffLimits?.(tab.windowId).catch(() => false)) ?? false);
      }
      if (offLimits.get(tab.windowId)) continue;
      const known = this.entries.get(tab.id);
      // Chrome's own "last accessed" time covers a tab the registry has not seen in front yet
      const accessed = Math.min(now, (tab as { lastAccessed?: number }).lastAccessed ?? 0);
      const lastActiveAt = Math.max(known?.lastActiveAt ?? 0, accessed) || now;
      listed.push({
        id: tab.id,
        windowId: tab.windowId,
        url: tab.url ?? '',
        host,
        title: (tab.title ?? '').slice(0, TITLE_MAX),
        openedAt: known?.openedAt ?? lastActiveAt,
        lastActiveAt,
        active: tab.active === true,
        heldBy: this.deps.holderOf?.(tab.id) ?? null,
      });
    }
    // Tabs that closed while no event reached us are forgotten
    let dropped = false;
    for (const id of [...this.entries.keys()]) {
      if (!live.has(id)) dropped = this.entries.delete(id) || dropped;
    }
    if (dropped) this.save();
    return listed.sort((a, b) => Number(b.active) - Number(a.active) || b.lastActiveAt - a.lastActiveAt);
  }
}

/** Whether a tab's site is the named one: the site itself or a part of it ("app.slack.com" is on "slack.com"). */
export function onSite(host: string, site: string): boolean {
  return host !== '' && site !== '' && (host === site || host.endsWith(`.${site}`));
}

/**
 * The tabs that match what was asked for: a site ("facebook.com", "slack") or words from the title. Every word
 * must appear in the site, the title or the address.
 */
export function matchTabs<T extends Pick<TabEntry, 'host' | 'title' | 'url'>>(tabs: T[], query: string): T[] {
  const words = query
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return [];
  return tabs.filter(tab => {
    const text = `${tab.host} ${tab.title} ${tab.url}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
}

/**
 * The open tabs as one line per site, most recently used first: "facebook.com: 1 tab, open 3 h, last used 20 min
 * ago". A tab another task holds is counted as busy.
 */
export function siteLines(tabs: ListedTab[], now: number, self: string | null = null, limit = 30): string[] {
  const sites = new Map<string, ListedTab[]>();
  for (const tab of tabs) {
    const group = sites.get(tab.host);
    if (group) group.push(tab);
    else sites.set(tab.host, [tab]);
  }
  const lines = [...sites.entries()]
    .map(([host, group]) => {
      const front = group.some(tab => tab.active);
      const lastActiveAt = Math.max(...group.map(tab => tab.lastActiveAt));
      const openedAt = Math.min(...group.map(tab => tab.openedAt));
      const busy = group.filter(tab => tab.heldBy !== null && tab.heldBy !== self).length;
      const used = front ? 'in front now' : `last used ${ageText(now - lastActiveAt)} ago`;
      const held = busy === 0 ? '' : busy === group.length ? ' (busy with another task)' : ` (${busy} busy)`;
      return {
        front,
        lastActiveAt,
        text: `${host}: ${group.length} ${group.length === 1 ? 'tab' : 'tabs'}, open ${ageText(now - openedAt)}, ${used}${held}`,
      };
    })
    .sort((a, b) => Number(b.front) - Number(a.front) || b.lastActiveAt - a.lastActiveAt);
  const shown = lines.slice(0, limit).map(line => line.text);
  if (lines.length > limit) shown[limit - 1] = `and ${lines.length - limit + 1} more sites (find_tab finds them)`;
  return shown;
}

/** The one registry of the background. Its holder and off-limits checks are set in ../tabs/register.ts. */
export const tabRegistry = new TabRegistry();
