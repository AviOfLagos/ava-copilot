import { firewallStore } from '@extension/storage';
import { tabRegistry } from '../browser/tabRegistry';
import { isUrlAllowed } from '../browser/util';
import { createLogger } from '../log';
import type { SiteHint } from '../threads/binding';
import { siteNamed } from './hint';

const logger = createLogger('TabReuse');

/**
 * The site hint for a new task: the open site its words name, with the check that says which of that site's
 * tabs may be taken. A tab may be taken when it is a web page in an ordinary window (never a private one, never
 * the agents' own), the firewall allows it, and no running task holds it.
 *
 * @param isFree - Whether no running task holds the tab
 * @returns The hint, or undefined when the task names no open site. Never throws: without a hint the task
 *   starts on the tab in front, as before.
 */
export async function siteHintFor(text: string, isFree: (tabId: number) => boolean): Promise<SiteHint | undefined> {
  try {
    const firewall = await firewallStore.getFirewall();
    const allowList = firewall.enabled ? firewall.allowList : [];
    const denyList = firewall.enabled ? firewall.denyList : [];
    const usable = (await tabRegistry.list()).filter(
      tab => isFree(tab.id) && isUrlAllowed(tab.url, allowList, denyList),
    );
    const site = siteNamed(
      text,
      usable.map(tab => tab.host),
    );
    if (!site) return undefined;
    // Exactly that address: a hint for "slack.com" never reaches a tab on another part of the same domain
    const ids = new Set(usable.filter(tab => tab.host === site).map(tab => tab.id));
    return { site, usable: tab => tab.id !== undefined && ids.has(tab.id) };
  } catch (error) {
    logger.warning('Could not look for an open tab to reuse', error);
    return undefined;
  }
}
