import type { AgentProfile } from '@extension/storage';
import { createLogger } from '../log';

/**
 * The agents' own browser window: one window, never focused, made minimized when the first agent needs a
 * tab, holding a tab group per agent named after it. Agents work only there, so they never touch the tab the
 * user is on and never take the focus. Which window it is, and which group is whose, is kept in session
 * storage, so a restarted background finds them again; a window the user closed is made again when needed.
 */

const logger = createLogger('AgentWindow');

const STATE_KEY = 'agent-window';
// Tabs an agent keeps between runs; older idle ones are closed when a run ends
export const TABS_KEPT = 3;

type GroupColor = `${chrome.tabGroups.Color}`;
const COLORS: GroupColor[] = ['blue', 'cyan', 'green', 'purple', 'pink', 'orange', 'yellow', 'red'];

interface WindowState {
  windowId: number | null;
  // Agent id → its tab group in the window
  groups: Record<string, number>;
}

export interface AgentTab {
  tabId: number;
  windowId: number;
  groupId: number;
}

export interface AgentTabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
}

/** The colour of an agent's tab group: the same for the same agent, every time. */
export function colorFor(agentId: string): GroupColor {
  let hash = 0;
  for (const char of agentId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length]!;
}

export class AgentWindow {
  private queue: Promise<unknown> = Promise.resolve();
  // The window id as last read, for the tab watcher's quick check
  private known: number | null = null;

  constructor(
    // A tab a running chat holds is never taken for another run
    private readonly busy: (tabId: number) => boolean = () => false,
  ) {}

  private async state(): Promise<WindowState> {
    const items: Record<string, unknown> = await chrome.storage.session.get(STATE_KEY).catch(() => ({}));
    const stored = items[STATE_KEY] as WindowState | undefined;
    const state = { windowId: stored?.windowId ?? null, groups: { ...(stored?.groups ?? {}) } };
    this.known = state.windowId;
    return state;
  }

  private async save(state: WindowState): Promise<void> {
    this.known = state.windowId;
    await chrome.storage.session.set({ [STATE_KEY]: state }).catch(() => {});
  }

  // One change to the window at a time: two runs starting together must not make two windows
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Whether a window is the agents' window (from what was last read; refreshed on every change). */
  async isAgentWindow(windowId: number | undefined): Promise<boolean> {
    if (windowId === undefined) return false;
    if (this.known === null) await this.state();
    return this.known === windowId;
  }

  /** The user closed the agents' window: the next run makes a new one. */
  async forget(windowId: number): Promise<void> {
    const state = await this.state();
    if (state.windowId === windowId) await this.save({ windowId: null, groups: {} });
  }

  private async liveWindow(state: WindowState): Promise<number | null> {
    if (state.windowId === null) return null;
    const window = await chrome.windows.get(state.windowId).catch(() => null);
    return window?.id ?? null;
  }

  /**
   * A tab for an agent's run, in its group of the agents' window, opened on the start page. An idle tab of
   * its own is reused; the window is made (minimized, unfocused) when there is none.
   */
  tabFor(agent: Pick<AgentProfile, 'id' | 'name'>, url: string): Promise<AgentTab> {
    return this.serial(async () => {
      const state = await this.state();
      let windowId = await this.liveWindow(state);
      let tabId: number | null = null;
      if (windowId === null) {
        const window = await chrome.windows.create({ url, focused: false, state: 'minimized', type: 'normal' });
        if (window?.id === undefined) throw new Error('Could not open the agents window');
        windowId = window.id;
        tabId = window.tabs?.[0]?.id ?? null;
        state.windowId = windowId;
        state.groups = {};
      }

      let groupId: number | null = state.groups[agent.id] ?? null;
      if (groupId !== null) {
        const group = await chrome.tabGroups.get(groupId).catch(() => null);
        if (!group || group.windowId !== windowId) groupId = null;
      }

      if (tabId === null && groupId !== null) {
        const own = await chrome.tabs.query({ groupId });
        const idle = own.find(tab => tab.id !== undefined && !this.busy(tab.id));
        if (idle?.id !== undefined) {
          tabId = idle.id;
          await chrome.tabs.update(tabId, { url, active: true });
        }
      }
      if (tabId === null) {
        const tab = await chrome.tabs.create({ windowId, url, active: true });
        if (tab.id === undefined) throw new Error('Could not open a tab for the agent');
        tabId = tab.id;
      }
      // Its page must not be unloaded to save memory while it works
      await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});

      const grouped = await chrome.tabs.group(
        groupId !== null ? { tabIds: [tabId], groupId } : { tabIds: [tabId], createProperties: { windowId } },
      );
      if (grouped !== groupId) {
        await chrome.tabGroups
          .update(grouped, { title: agent.name.slice(0, 40), color: colorFor(agent.id), collapsed: false })
          .catch(error => logger.warning('Could not name the agent tab group', error));
      }
      state.groups[agent.id] = grouped;
      await this.save(state);
      return { tabId, windowId, groupId: grouped };
    });
  }

  /** The tabs an agent has in the agents' window. */
  async tabsOf(agentId: string): Promise<AgentTabInfo[]> {
    const state = await this.state();
    const groupId = state.groups[agentId];
    if (groupId === undefined || (await this.liveWindow(state)) === null) return [];
    const tabs = await chrome.tabs.query({ groupId }).catch(() => [] as chrome.tabs.Tab[]);
    return tabs
      .filter(tab => tab.id !== undefined)
      .map(tab => ({ id: tab.id!, title: tab.title ?? '', url: tab.url ?? '', active: tab.active }));
  }

  /** Shows one of an agent's tabs: the user asked, so its window comes to the front. */
  async focus(tabId: number): Promise<void> {
    const tab = await chrome.tabs.get(tabId);
    if (!(await this.isAgentWindow(tab.windowId))) throw new Error('That tab is not in the agents window');
    await chrome.windows.update(tab.windowId, { focused: true, state: 'normal' });
    await chrome.tabs.update(tabId, { active: true });
  }

  /** Closes an agent's oldest idle tabs past TABS_KEPT. */
  async trim(agentId: string, keep = TABS_KEPT): Promise<void> {
    const state = await this.state();
    const groupId = state.groups[agentId];
    if (groupId === undefined) return;
    const tabs = await chrome.tabs.query({ groupId }).catch(() => [] as chrome.tabs.Tab[]);
    if (tabs.length <= keep) return;
    const idle = tabs
      .filter(tab => tab.id !== undefined && !this.busy(tab.id))
      .sort((a, b) => (a.lastAccessed ?? 0) - (b.lastAccessed ?? 0));
    const extra = idle.slice(0, tabs.length - keep).map(tab => tab.id!);
    if (extra.length) await chrome.tabs.remove(extra).catch(() => {});
  }

  /** Closes every tab of an agent that is gone. */
  async close(agentId: string): Promise<void> {
    const state = await this.state();
    const groupId = state.groups[agentId];
    if (groupId === undefined) return;
    const tabs = await chrome.tabs.query({ groupId }).catch(() => [] as chrome.tabs.Tab[]);
    const ids = tabs.map(tab => tab.id).filter((id): id is number => id !== undefined && !this.busy(id));
    if (ids.length) await chrome.tabs.remove(ids).catch(() => {});
    delete state.groups[agentId];
    await this.save(state);
  }
}
