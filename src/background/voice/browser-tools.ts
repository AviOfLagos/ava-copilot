import { firewallStore } from '@extension/storage';
import { isUrlAllowed } from '../browser/util';
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

/** A page's site, the one way every check here reads it: hostname, lower case, without www. */
function hostOf(url = ''): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Runs in the page: its text and the address it was read from, in one step, so the address checked
 * is the one the text came from. Self-contained, as every function sent to a page must be.
 */
export const readPageWithAddress = (max: number): { text: string; total: number; href: string } => {
  const all = (document.body ? document.body.innerText : '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: all.slice(0, max), total: all.length, href: location.href };
};

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
  if (!tab?.id || (id !== undefined && tab.windowId !== id)) return 'There is no such tab in this window.';
  if (heldByThread(tab.id)) return 'A browser task is working in that tab; ask again when it is done.';
  if (tab.incognito) return 'That tab is private and cannot be read.';
  if (tab.url && !(await allowedByFirewall(tab.url))) return 'That site is on the blocked list, so it was not read.';
  if (!tab.url || !/^https?:/.test(tab.url)) {
    return `The tab "${tab.title ?? ''}" is a browser page that cannot be read.`;
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: readPageWithAddress,
    args: [PAGE_CHARS],
  });
  const slice = result?.result as { text?: string; total?: number; href?: string } | undefined;
  // The tab may have moved on between the check above and the read: check the page that was read
  if (!slice?.href || !/^https?:/.test(slice.href) || !(await allowedByFirewall(slice.href))) {
    return 'That page changed while it was being read, or cannot be read.';
  }
  const text = slice.text?.trim() ?? '';
  if (!text) return `The page "${tab.title}" shows no text.`;
  const cut = (slice?.total ?? 0) > PAGE_CHARS ? ' (the start of a longer page)' : '';
  return `Page "${tab.title}" (${hostOf(tab.url)})${cut}:\n${wrapUntrustedContent(text)}`;
}

// A hostname shaped like this is more likely carrying data than naming a site
const MAX_LABELS = 4;
const MAX_LABEL = 24;

// A spoken search is a few words; a longer query is cut, so it cannot carry a page's worth of data
const MAX_QUERY = 120;

const searchFor = (text: string) => `https://www.google.com/search?q=${encodeURIComponent(text.slice(0, MAX_QUERY))}`;

/** Whether the firewall lets the voice tools touch an address, as it does the agent. */
async function allowedByFirewall(url: string): Promise<boolean> {
  const firewall = await firewallStore.getFirewall();
  return !firewall.enabled || isUrlAllowed(url, firewall.allowList, firewall.denyList);
}

/**
 * A web address from what was said: a site, or a search for anything else. Page text the model has
 * read can carry instructions, so an address it writes must not be able to carry data out: the
 * query, fragment and credentials are dropped, the path is kept only on a site already open in a
 * tab, and a hostname with many or long labels becomes a search instead.
 *
 * @param openPages - Pages already open (origin and path); only these keep their path, since
 *   reopening one carries nothing new, while any other path could carry data even on a known site
 */
export function addressFor(target: string, openPages: Set<string> = new Set()): string {
  const text = target.trim();
  const candidate = /^https?:\/\//i.test(text)
    ? text
    : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text)
      ? `https://${text}`
      : null;
  if (!candidate) return searchFor(text);
  try {
    const url = new URL(candidate);
    const labels = url.hostname.split('.');
    if (labels.length > MAX_LABELS || labels.some(label => label.length > MAX_LABEL)) return searchFor(text);
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    if (!openPages.has(`${url.origin}${url.pathname}`)) url.pathname = '/';
    return url.toString();
  } catch {
    return searchFor(text);
  }
}

/** Opens a new tab in front, unless the address is on the blocked list. */
/**
 * Whether the user named this site: its main name (github for github.com, zedu for zedu.chat) is
 * among the words they said, spoken or spelled with spaces.
 */
// Words people say around a site name; a site named like one of them is never taken as named
const COMMON_WORDS = new Set(
  'open page site tab tabs read show search find look link here this that what with from your mine please news mail home'.split(
    ' ',
  ),
);

export function spokenSite(host: string, spoken: string): boolean {
  const labels = host
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.');
  const name = (labels.length > 2 && labels.at(-2)!.length <= 3 ? labels.at(-3) : labels.at(-2)) ?? labels[0];
  if (!name || name.length < 4 || COMMON_WORDS.has(name)) return false;
  const words = spoken
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(Boolean);
  // The name as one word, or spelled across words ("y combinator" for ycombinator)
  if (words.includes(name)) return true;
  for (let start = 0; start < words.length; start++) {
    let joined = '';
    for (let end = start; end < words.length && joined.length < name.length; end++) {
      joined += words[end];
      if (joined === name) return true;
    }
  }
  return false;
}

/**
 * Opens a new tab in front. A site opens only if it is already open in a tab or the user named it;
 * a search is always allowed. Page text the model read cannot choose where the browser goes.
 *
 * @param spoken - What the user said recently
 */
export async function openTab(target: string, windowId?: number, spoken = ''): Promise<string> {
  const open = await chrome.tabs.query({});
  const knownHosts = new Set(open.map(tab => hostOf(tab.url)).filter(Boolean));
  const openPages = new Set(
    open.flatMap(tab => {
      try {
        const page = new URL(tab.url ?? '');
        return [`${page.origin}${page.pathname}`];
      } catch {
        return [];
      }
    }),
  );
  const url = addressFor(target, openPages);
  const host = hostOf(url);
  const isSearch = host === 'google.com' && new URL(url).pathname === '/search';
  if (!isSearch && !knownHosts.has(host) && !spokenSite(host, spoken)) {
    return `Not opened: ${host} is not open and the user did not name it. Ask the user to say the site they want.`;
  }
  if (!(await allowedByFirewall(url))) {
    return `${hostOf(url)} is on the blocked list, so it was not opened.`;
  }
  const id = await windowOf(windowId);
  const tab = await chrome.tabs.create({ url, active: true, ...(id !== undefined ? { windowId: id } : {}) });
  return `Opened tab ${tab.id}: ${hostOf(url)}.`;
}

/** Brings a tab to the front. */
export async function switchTab(tabId: number, windowId?: number): Promise<string> {
  const id = await windowOf(windowId);
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab?.id || (id !== undefined && tab.windowId !== id)) return `There is no tab ${tabId} in this window.`;
  if (tab.incognito || (tab.url && !(await allowedByFirewall(tab.url)))) return 'That tab cannot be opened from here.';
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return `Switched to tab ${tab.id}: ${tab.title}.`;
}
