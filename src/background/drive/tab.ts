import { firewallStore } from '@extension/storage';
import type { AgentContext } from '../agent/types';
import { isUrlAllowed } from '../browser/util';
import { isDriveUrl, isSignInUrl } from './urls';

/**
 * The one tab Drive work happens in. For a chat it is a tab bound to that chat (one it already has on Drive, a
 * free Drive tab it may take over, or a new one it opens); for the panel and voice it is a tab the extension opened
 * for itself. A tab the user has open and no chat holds is never driven without that binding.
 */
export interface DriveTab {
  readonly tabId: number;
  /** Opens an address in the tab and returns the address it ended up at (after Google's redirects). */
  navigate(url: string): Promise<string>;
  /** Runs one of ./page.ts's functions; one result per frame (only the top frame unless allFrames). */
  run<A, R>(
    func: (arg: A) => R | Promise<R>,
    arg: A,
    options?: { world?: 'ISOLATED' | 'MAIN'; allFrames?: boolean },
  ): Promise<R[]>;
  info(): Promise<{ url: string; title: string }>;
  /** Brings the tab in front of the user, e.g. for them to sign in. */
  show(): Promise<void>;
}

export class DriveBlockedError extends Error {
  constructor(url: string) {
    super(`The firewall does not allow ${new URL(url).host}.`);
    this.name = 'DriveBlockedError';
  }
}

/** Whether the firewall lets Ava see this address. */
export async function firewallAllows(url: string): Promise<boolean> {
  const firewall = await firewallStore.getFirewall();
  return !firewall.enabled || isUrlAllowed(url, firewall.allowList, firewall.denyList);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Waits until the tab has loaded and its address stayed the same for a moment (Google redirects a lot). */
export async function settle(tabId: number, before = '', timeoutMs = 30_000): Promise<chrome.tabs.Tab> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let last = '';
  let stableSince = 0;
  // The tab may still say "complete" for the page it is leaving: wait to see it move (or a few seconds pass)
  let moved = false;
  let tab = await chrome.tabs.get(tabId);
  while (Date.now() < deadline) {
    tab = await chrome.tabs.get(tabId);
    const url = tab.url || tab.pendingUrl || '';
    if (tab.status !== 'complete' || url !== before || Date.now() - started > 3000) moved = true;
    if (moved && tab.status === 'complete' && url && url !== 'about:blank') {
      if (url !== last) {
        last = url;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 600) {
        return tab;
      }
    } else {
      last = '';
    }
    await sleep(200);
  }
  return tab;
}

async function runScript<A, R>(
  tabId: number,
  func: (arg: A) => R | Promise<R>,
  arg: A,
  options: { world?: 'ISOLATED' | 'MAIN'; allFrames?: boolean } = {},
): Promise<R[]> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: options.allFrames ?? false },
    world: options.world ?? 'ISOLATED',
    func: func as (arg: unknown) => unknown,
    args: [arg as unknown],
  });
  return results.map(result => result?.result as R);
}

class ChromeDriveTab implements DriveTab {
  constructor(
    readonly tabId: number,
    private readonly go: (url: string) => Promise<void>,
  ) {}

  async navigate(url: string): Promise<string> {
    if (!(await firewallAllows(url))) throw new DriveBlockedError(url);
    const before = (await chrome.tabs.get(this.tabId)).url ?? '';
    await this.go(url);
    const tab = await settle(this.tabId, before);
    const landed = tab.url ?? '';
    // A redirect may not leave Google for a site the firewall blocks; the sign-in page is Google's own
    if (landed && !isSignInUrl(landed) && !(await firewallAllows(landed))) throw new DriveBlockedError(landed);
    return landed;
  }

  run<A, R>(
    func: (arg: A) => R | Promise<R>,
    arg: A,
    options?: { world?: 'ISOLATED' | 'MAIN'; allFrames?: boolean },
  ): Promise<R[]> {
    return runScript(this.tabId, func, arg, options);
  }

  async info(): Promise<{ url: string; title: string }> {
    const tab = await chrome.tabs.get(this.tabId);
    return { url: tab.url ?? '', title: tab.title ?? '' };
  }

  async show(): Promise<void> {
    const tab = await chrome.tabs.update(this.tabId, { active: true });
    if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
}

/**
 * The chat's Drive tab: a bound tab already on Drive or Docs, else a free one the binding may take over, else a
 * new tab at `firstUrl`. Navigation goes through the chat's browser context, which applies its firewall too.
 */
export async function chatDriveTab(context: AgentContext, firstUrl: string): Promise<DriveTab> {
  const browser = context.browserContext;
  const go = async (url: string) => {
    await browser.navigateTo(url);
  };
  // The tabs this chat may use (its own, and free ones its binding may take over: never another chat's, never
  // a private one), on Drive or Docs
  const usable = (await browser.getTabInfos()).filter(tab => isDriveUrl(tab.url));
  for (const tab of usable) {
    if (!(await firewallAllows(tab.url))) continue;
    try {
      await browser.switchTab(tab.id);
      return new ChromeDriveTab(tab.id, go);
    } catch {
      // Taken by another chat meanwhile, or in another window: not this chat's
    }
  }
  if (!(await firewallAllows(firstUrl))) throw new DriveBlockedError(firstUrl);
  const page = await browser.openTab(firstUrl);
  return new ChromeDriveTab(page.tabId, go);
}

// The tab the extension opened for the panel's "Add from Drive" and voice, kept across worker restarts
const OWN_TAB_KEY = 'drive:ownTab';

/**
 * The extension's own Drive tab, for work no chat runs (the panel, voice). It is reused while it stays on Google
 * and no chat has taken it; otherwise a new one opens in the background of the last focused window.
 *
 * @param heldByChat - Whether a chat holds a tab (ThreadManager.holderOf)
 */
export async function ownDriveTab(heldByChat: (tabId: number) => boolean): Promise<DriveTab> {
  let tabId = -1;
  const go = async (url: string) => {
    await chrome.tabs.update(tabId, { url });
  };
  const saved = (await chrome.storage.session.get(OWN_TAB_KEY))[OWN_TAB_KEY] as number | undefined;
  if (typeof saved === 'number') {
    const tab = await chrome.tabs.get(saved).catch(() => undefined);
    if (tab?.id !== undefined && !heldByChat(tab.id) && (isDriveUrl(tab.url) || isSignInUrl(tab.url))) tabId = tab.id;
  }
  if (tabId < 0) {
    const window = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
    const tab = await chrome.tabs.create({
      url: 'about:blank',
      active: false,
      windowId: window && !window.incognito ? window.id : undefined,
    });
    if (tab.id === undefined) throw new Error('No tab could be opened for Google Drive.');
    tabId = tab.id;
    await chrome.storage.session.set({ [OWN_TAB_KEY]: tabId });
  }
  return new ChromeDriveTab(tabId, go);
}
