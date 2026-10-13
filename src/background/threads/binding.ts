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
    this.tabs.add(tabId);
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

/**
 * Picks the tabs a run binds to, from the window the user sent the task from: the whole tab group
 * when the active tab is in one, the highlighted tabs when several are selected, otherwise the
 * active tab alone.
 */
export async function tabsToBind(windowId?: number): Promise<{ tabIds: number[]; groupId: number | null }> {
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
    const groupId = await chrome.tabs.group({
      tabIds: binding.tabIds as [number, ...number[]],
      ...(binding.groupId !== null ? { groupId: binding.groupId } : {}),
    });
    if (binding.groupId === null) {
      await chrome.tabGroups.update(groupId, { title: title.slice(0, 40) || 'Nex Copilot', color: 'blue' });
    }
    binding.groupId = groupId;
    return groupId;
  } catch (error) {
    // Grouping is only for the user's eyes; the binding holds either way
    logger.warning('Could not group the thread tabs', error);
    return binding.groupId;
  }
}
