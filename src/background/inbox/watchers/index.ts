import { db as defaultDb, firewallStore, inboxSettingsStore } from '@extension/storage';
import type { AviCopilotDb } from '@extension/storage';
import { isUrlAllowed } from '../../browser/util';
import { createLogger } from '../../log';
import { summarizerModel } from '../model';
import { addInboxItem } from '../store';
import { summarizeMessageItem } from '../summarize';
import { gmailWatcher } from './gmail';
import { slackWatcher } from './slack';
import type { Watcher } from './types';
import { whatsappWatcher } from './whatsapp';
import { toInboxDrafts } from './normalize';
import { learnFromWatcher } from '../../people/sources';

const logger = createLogger('Inbox');

export const WATCHERS: Watcher[] = [whatsappWatcher, slackWatcher, gmailWatcher];

async function allowedByFirewall(url: string): Promise<boolean> {
  const firewall = await firewallStore.getFirewall();
  return !firewall.enabled || isUrlAllowed(url, firewall.allowList, firewall.denyList);
}

/**
 * Reads unread conversations from every open, non-incognito tab whose watcher is turned on, adds
 * what is new to the Inbox, and queues each for summarising. Never throws: one bad tab, or a probe
 * that finds nothing, never stops the rest. Returns how many new items were added, for "Check now".
 */
export async function runWatchers(database: AviCopilotDb = defaultDb): Promise<number> {
  const settings = await inboxSettingsStore.getSettings();
  const enabled = WATCHERS.filter(watcher => settings[watcher.settingKey]);
  if (enabled.length === 0) return 0;

  const tabs = await chrome.tabs.query({});
  let added = 0;
  for (const tab of tabs) {
    if (!tab.id || !tab.url || tab.incognito) continue;
    const watcher = enabled.find(candidate => candidate.matchesUrl(tab.url as string));
    if (!watcher) continue;
    if (!(await allowedByFirewall(tab.url))) continue;
    try {
      added += await runOne(watcher, tab.id, database);
    } catch (error) {
      logger.warning(`The ${watcher.source} watcher could not read a tab`, error);
    }
  }
  return added;
}

async function runOne(watcher: Watcher, tabId: number, database: AviCopilotDb): Promise<number> {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: watcher.probe }).catch(() => []);
  const rows = Array.isArray(result?.result) ? result.result : [];
  const drafts = toInboxDrafts(watcher.source, rows);
  // Who wrote is learned for people, on this computer only (docs/pm-desk.md Part 5)
  void learnFromWatcher(watcher.source, rows);
  let added = 0;
  for (const draft of drafts) {
    const before = await database.inbox.get(`${draft.source}|${draft.externalId}`);
    const item = await addInboxItem(draft, database);
    if (!before && item.externalId === draft.externalId) {
      added += 1;
      void summarizeMessageItem(item, { model: summarizerModel }, database);
    }
  }
  return added;
}
