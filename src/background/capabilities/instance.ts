import { firewallStore } from '@extension/storage';
import type { FirewallConfig } from '@extension/storage';
import { isUrlAllowed } from '../browser/util';
import { focusLine, targetTab, TabTracker } from './tabs';
import type { SeenTab } from './tabs';

/** The background's one tab tracker; its listeners are added in ./register.ts at startup. */
export const tabTracker = new TabTracker({
  tabs: chrome.tabs,
  windows: chrome.windows,
  session: chrome.storage.session,
});

// The firewall, kept current so the tab line stays synchronous. Until it is read, every web page counts as blocked.
let firewall: FirewallConfig | null = null;
const readFirewall = () =>
  void firewallStore
    .getFirewall()
    .then(config => (firewall = config))
    .catch(() => {});
readFirewall();
firewallStore.subscribe(readFirewall);

/** Whether the firewall lets Ava see this address. */
export function tabAllowed(url: string): boolean {
  if (!firewall) return false;
  return !firewall.enabled || isUrlAllowed(url, firewall.allowList, firewall.denyList);
}

/** "The user's tab in front: … (previous: …)", or '' before anything was seen. Blocked sites are not named. */
export function currentTabLine(): string {
  return focusLine(tabTracker.state, tabAllowed);
}

/** The tab "this" means for a tool, never a private tab or a blocked site. */
export function currentTarget(): SeenTab | null {
  return targetTab(tabTracker.state, tabAllowed);
}
