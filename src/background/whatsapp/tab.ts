import { firewallStore } from '@extension/storage';
import { isUrlAllowed } from '../browser/util';
import { matchesWhatsappUrl } from '../inbox/watchers/whatsapp';
import { probePage } from './page';
import type { WaProbe } from './page';
import type { WhatsappSelectors } from './selectors';

/** The user's own WhatsApp Web tab: open, not private, and allowed by the firewall. Null when there is none. */
export async function findWhatsappTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({});
  const firewall = await firewallStore.getFirewall();
  const candidates = tabs.filter(
    tab =>
      tab.id !== undefined &&
      !tab.incognito &&
      typeof tab.url === 'string' &&
      matchesWhatsappUrl(tab.url) &&
      (!firewall.enabled || isUrlAllowed(tab.url, firewall.allowList, firewall.denyList)),
  );
  // The one the user looked at last
  candidates.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return candidates[0] ?? null;
}

/** Runs one of ./page.ts's functions in the tab and returns its result. */
export async function runInTab<A, R>(
  tabId: number,
  func: (arg: A) => R | Promise<R>,
  arg: A,
  world: 'ISOLATED' | 'MAIN' = 'ISOLATED',
): Promise<R> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    func: func as (arg: unknown) => unknown,
    args: [arg as unknown],
  });
  return result?.result as R;
}

export async function probeTab(tabId: number, sel: WhatsappSelectors): Promise<WaProbe> {
  try {
    return (await runInTab(tabId, probePage, { sel })) ?? emptyProbe();
  } catch {
    // A tab between pages cannot run scripts yet
    return emptyProbe();
  }
}

function emptyProbe(): WaProbe {
  return { state: 'loading', header: '', composerText: '', outgoing: 0 };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Waits until the tab shows one of `states`, or the time runs out; returns the last reading. */
export async function waitForState(
  tabId: number,
  sel: WhatsappSelectors,
  states: WaProbe['state'][],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<WaProbe> {
  const deadline = Date.now() + timeoutMs;
  let probe = await probeTab(tabId, sel);
  while (!states.includes(probe.state) && Date.now() < deadline && !signal?.aborted) {
    await sleep(400);
    probe = await probeTab(tabId, sel);
  }
  return probe;
}
