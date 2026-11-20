import { hostOf, onSite } from '../browser/tabRegistry';
import { createLogger } from '../log';

const logger = createLogger('TabBinding');

/**
 * The tabs a thread may act on. A thread is bound to a tab, or to the tabs of a tab group, when its
 * run starts; tabs it opens itself join the binding. Every other tab is off limits to it.
 */
export class TabBinding {
  private readonly tabs: Set<number>;
  // Whether a tab outside the binding may join it: set by the thread manager to "no other running
  // thread holds it". Unset, only bound tabs and tabs they open are allowed.
  canAdopt: ((tabId: number) => boolean) | null = null;
  // Told when a tab joins the binding mid-run (one the task opened, or a free one it took over)
  onAdd: ((tabId: number) => void) | null = null;
  // Whether a free tab may be taken from any ordinary window. Off, only from the windows the binding already
  // works in: an agent's run stays in the agents' window and never takes a tab the user has open elsewhere.
  anyWindow = false;
  // The site of the already-open tab this run started on, when the task named one (see tabsToBind)
  reusedSite: string | null = null;

  constructor(
    tabIds: number[],
    public groupId: number | null = null,
  ) {
    this.tabs = new Set(tabIds);
  }

  has(tabId: number): boolean {
    return this.tabs.has(tabId);
  }

  add(tabId: number): void {
    const joined = !this.tabs.has(tabId);
    this.tabs.add(tabId);
    if (joined) this.onAdd?.(tabId);
  }

  remove(tabId: number): void {
    this.tabs.delete(tabId);
  }

  get tabIds(): number[] {
    return [...this.tabs];
  }

  get size(): number {
    return this.tabs.size;
  }
}

export class TabNotBoundError extends Error {
  constructor(tabId: number) {
    super(`Tab ${tabId} is not bound to this thread. Use only the tabs listed for this task.`);
    this.name = 'TabNotBoundError';
  }
}

/** The site a task names, and which of the open tabs on it may be taken (free, allowed, not private). */
export interface SiteHint {
  // "facebook.com": the site itself and its parts ("m.facebook.com")
  site: string;
  usable: (tab: chrome.tabs.Tab) => boolean;
}

/** The free open tab on the hinted site that was used last, from any ordinary window. */
async function openTabOn(hint: SiteHint): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  const lastUsed = (tab: chrome.tabs.Tab) => (tab as { lastAccessed?: number }).lastAccessed ?? 0;
  const matches = tabs
    .filter(tab => tab.id !== undefined && !tab.incognito && onSite(hostOf(tab.url), hint.site) && hint.usable(tab))
    .sort((a, b) => Number(b.active) - Number(a.active) || lastUsed(b) - lastUsed(a));
  return matches[0] ?? null;
}

/**
 * Picks the tabs a run binds to. With a site hint (the site the task names), a free tab already open on that
 * site is used, from any ordinary window, unless the tab in front is on that site already. Otherwise, from the
 * window the user sent the task from: the whole tab group when the active tab is in one, the highlighted tabs
 * when several are selected, otherwise the active tab alone.
 */
export async function tabsToBind(
  windowId?: number,
  hint?: SiteHint,
): Promise<{ tabIds: number[]; groupId: number | null; reusedSite?: string }> {
  let window: chrome.windows.Window | undefined;
  if (windowId !== undefined) {
    window = await chrome.windows.get(windowId).catch(() => undefined);
  }
  if (!window || window.type !== 'normal') {
    // A pop-out panel has no tabs of its own: use the last window the user worked in
    window = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
  }
  if (!window?.id) {
    throw new Error('No browser window to work in');
  }

  const [active] = await chrome.tabs.query({ windowId: window.id, active: true });
  if (!active?.id) {
    throw new Error('No active tab to work in');
  }
  if (hint && !onSite(hostOf(active.url), hint.site)) {
    const open = await openTabOn(hint).catch(() => null);
    if (open?.id !== undefined) {
      return { tabIds: [open.id], groupId: null, reusedSite: hint.site };
    }
  }
  if (active.groupId !== undefined && active.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    const grouped = await chrome.tabs.query({ groupId: active.groupId });
    return {
      tabIds: grouped.map(tab => tab.id).filter((id): id is number => id !== undefined),
      groupId: active.groupId,
    };
  }
  const highlighted = await chrome.tabs.query({ windowId: window.id, highlighted: true });
  const ids = highlighted.map(tab => tab.id).filter((id): id is number => id !== undefined);
  // The active tab goes first: it is where the agent starts
  return { tabIds: ids.length > 1 ? [active.id, ...ids.filter(id => id !== active.id)] : [active.id], groupId: null };
}

/**
 * Puts a thread's tabs in one tab group named after the thread, so the user can see what it holds.
 *
 * @returns The group id, or the existing one when the tabs are already grouped
 */
export async function groupTabs(binding: TabBinding, title: string): Promise<number | null> {
  if (binding.size < 2) {
    return binding.groupId;
  }
  try {
    // Only the tabs in the first tab's window: grouping a tab taken over in another window would move it there
    const tabs = await Promise.all(binding.tabIds.map(tabId => chrome.tabs.get(tabId).catch(() => undefined)));
    const home = tabs[0]?.windowId;
    const tabIds = tabs.flatMap(tab => (tab?.id !== undefined && tab.windowId === home ? [tab.id] : []));
    if (tabIds.length < 2) {
      return binding.groupId;
    }
    const groupId = await chrome.tabs.group({
      tabIds: tabIds as [number, ...number[]],
      ...(binding.groupId !== null ? { groupId: binding.groupId } : {}),
    });
    if (binding.groupId === null) {
      await chrome.tabGroups.update(groupId, { title: title.slice(0, 40) || 'Ava Copilot', color: 'blue' });
    }
    binding.groupId = groupId;
    return groupId;
  } catch (error) {
    // Grouping is only for the user's eyes; the binding holds either way
    logger.warning('Could not group the thread tabs', error);
    return binding.groupId;
  }
}
