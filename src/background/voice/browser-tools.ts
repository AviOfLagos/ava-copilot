import { firewallStore } from '@extension/storage';
import { isUrlAllowed } from '../browser/util';
import { readPageText } from '../reader/probes';
import { wrapUntrustedContent } from '../agent/messages/utils';

// What the voice model gets of a page: enough to answer about it, short enough to speak from
export const PAGE_CHARS = 6000;

/** The window voice works in: the one it started from, else the last focused normal window. */
async function windowOf(windowId?: number): Promise<number | undefined> {
  if (windowId !== undefined) {
    const window = await chrome.windows.get(windowId).catch(() => undefined);
    if (window?.type === 'normal') return windowId;
  }
  return (await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined))?.id;
}

function hostOf(url = ''): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** The open tabs of the window, the one in front first, each with the id the other tools take. */
export async function listTabs(windowId?: number): Promise<string> {
  const id = await windowOf(windowId);
  const tabs = await chrome.tabs.query(id !== undefined ? { windowId: id } : {});
  if (tabs.length === 0) return 'No tabs are open.';
  const lines = [...tabs]
    .sort((a, b) => Number(b.active) - Number(a.active))
    .map(tab => `${tab.active ? '(in front) ' : ''}tab ${tab.id}: ${tab.title || 'Untitled'} — ${hostOf(tab.url)}`);
  return `Open tabs:\n${lines.join('\n')}`;
}

/**
 * The text of the page in front, or of a given tab. It is page content, never instructions, and it
 * says so to the model.
 */
export async function readPage(
  windowId?: number,
  tabId?: number,
  // A tab another running thread is working in is that thread's, not the conversation's
  heldByThread: (tabId: number) => boolean = () => false,
): Promise<string> {
  const id = await windowOf(windowId);
  const tab =
    tabId !== undefined
      ? await chrome.tabs.get(tabId).catch(() => undefined)
      : (await chrome.tabs.query(id !== undefined ? { windowId: id, active: true } : { active: true }))[0];
  if (!tab?.id) return 'There is no such tab.';
  if (heldByThread(tab.id)) return 'A browser task is working in that tab; ask again when it is done.';
  if (!tab.url || !/^https?:/.test(tab.url)) {
    return `The tab "${tab.title ?? ''}" is a browser page that cannot be read.`;
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: readPageText,
    args: [{ offset: 0, max: PAGE_CHARS }],
  });
  const slice = result?.result as { text?: string; total?: number } | undefined;
  const text = slice?.text?.trim() ?? '';
  if (!text) return `The page "${tab.title}" shows no text.`;
  const cut = (slice?.total ?? 0) > PAGE_CHARS ? ' (the start of a longer page)' : '';
  return `Page "${tab.title}" (${hostOf(tab.url)})${cut}:\n${wrapUntrustedContent(text)}`;
}

// The longest path an opened address keeps; a longer one could carry data out
const MAX_PATH = 64;

/**
 * A web address from what was said: a site, or a search for anything else. Page text the model has
 * read can carry instructions, so an address it writes never carries data: its query and fragment
 * are dropped, and so is a long path.
 */
export function addressFor(target: string): string {
  const text = target.trim();
  const candidate = /^https?:\/\//i.test(text)
    ? text
    : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text)
      ? `https://${text}`
      : null;
  if (!candidate) return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
  try {
    const url = new URL(candidate);
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    if (url.pathname.length > MAX_PATH) url.pathname = '/';
    return url.toString();
  } catch {
    return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
  }
}

/** Opens a new tab in front, unless the address is on the blocked list. */
export async function openTab(target: string, windowId?: number): Promise<string> {
  const url = addressFor(target);
  const firewall = await firewallStore.getFirewall();
  if (firewall.enabled && !isUrlAllowed(url, firewall.allowList, firewall.denyList)) {
    return `${hostOf(url)} is on the blocked list, so it was not opened.`;
  }
  const id = await windowOf(windowId);
  const tab = await chrome.tabs.create({ url, active: true, ...(id !== undefined ? { windowId: id } : {}) });
  return `Opened tab ${tab.id}: ${hostOf(url)}.`;
}

/** Brings a tab to the front. */
export async function switchTab(tabId: number): Promise<string> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab?.id) return `There is no tab ${tabId}.`;
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return `Switched to tab ${tab.id}: ${tab.title}.`;
}
