import type { AgentContext } from '../agent/types';
import { siteLines, tabRegistry } from '../browser/tabRegistry';
import type { ListedTab } from '../browser/tabRegistry';
import type { BrowserState } from '../browser/views';
import { createLogger } from '../log';

const logger = createLogger('TabsSection');

export interface TabsView {
  // The tabs listed one by one in the state message: the task's own and the free ones in its windows. Null
  // when the registry could not be read; then every available tab is listed, as before.
  near: Set<number> | null;
  // "Open tabs by site", for the state message; empty when there is nothing beyond the tabs listed one by one
  section: string;
}

/**
 * What a task is told about the tabs that are open. The tabs in its own windows are listed one by one, as
 * before. Tabs in the user's other windows would make that list long, so they are summed up by site, with age
 * and last use, and `find_tab` gives their ids. A tab another task holds is shown as busy and cannot be taken.
 *
 * Only tabs the task may use are counted (`browserState.tabs` already holds that check), plus the busy ones
 * for a task that may roam.
 */
export async function tabsViewFor(context: AgentContext, browserState: BrowserState): Promise<TabsView> {
  try {
    const listed = await tabRegistry.list();
    return tabsView(listed, browserState, context.taskId, Date.now(), context.browserContext.roams);
  } catch (error) {
    logger.warning('Could not list the open tabs', error);
    return { near: null, section: '' };
  }
}

export function tabsView(
  listed: ListedTab[],
  browserState: Pick<BrowserState, 'tabs' | 'tabId'>,
  taskId: string,
  now: number,
  // Whether the task may take tabs from the user's other windows; one that may not is told nothing of them
  roams = true,
): TabsView {
  const available = new Set(browserState.tabs.map(tab => tab.id));
  const byId = new Map(listed.map(tab => [tab.id, tab]));
  // The windows the task works in: its own tabs are the ones it holds
  const windows = new Set<number>();
  for (const tab of listed) {
    if (tab.heldBy === taskId || tab.id === browserState.tabId) windows.add(tab.windowId);
  }
  const near = new Set<number>();
  for (const id of available) {
    const tab = byId.get(id);
    // A tab the registry does not list (not a web page) stays in the one-by-one list
    if (!tab || windows.has(tab.windowId) || tab.heldBy === taskId) near.add(id);
  }
  // Elsewhere: free tabs the task may take, and tabs other tasks hold (shown as busy, never offered)
  const elsewhere = listed.filter(
    tab => (available.has(tab.id) && !near.has(tab.id)) || (roams && tab.heldBy !== null && tab.heldBy !== taskId),
  );
  if (!elsewhere.length) return { near, section: '' };
  const lines = siteLines(elsewhere, now, taskId);
  return {
    near,
    section: `Other tabs the user has open, by site (find_tab gives their ids; a busy one cannot be used):\n${lines
      .map(line => `  - ${line}`)
      .join('\n')}\n`,
  };
}
