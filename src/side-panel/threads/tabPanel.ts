import { useEffect, useRef } from 'react';
import type { ThreadRecord } from '@extension/storage';
import { TAB_PANELS_KEY } from '@src/background/threads/tabPanels';
import type { TabPanelMap } from '@src/background/threads/tabPanels';

/**
 * The tab this panel belongs to, from its address (`sidepanel.html?tab=12`). A panel opened another way (a pop-out
 * window, an extension tab) has none and works as one panel for every tab, as before.
 */
export function panelTabId(search: string = location.search): number | null {
  const value = new URLSearchParams(search).get('tab');
  if (value === null || !/^\d+$/.test(value)) return null;
  return Number(value);
}

/** What one tab's panel was showing when the user left it: restored when they come back. */
export interface TabPanelUi {
  draft: string;
  // Pixels from the top of the chat, or null when it was at the newest message
  scroll: number | null;
}

const uiKey = (tabId: number) => `tab-panel-ui:${tabId}`;

export async function loadUi(tabId: number): Promise<TabPanelUi | null> {
  const stored = (await chrome.storage.session.get(uiKey(tabId)))[uiKey(tabId)] as TabPanelUi | undefined;
  return stored ?? null;
}

export async function saveUi(tabId: number, ui: TabPanelUi): Promise<void> {
  await chrome.storage.session.set({ [uiKey(tabId)]: ui });
}

export async function threadOnTab(tabId: number): Promise<string | null> {
  const map = ((await chrome.storage.session.get(TAB_PANELS_KEY))[TAB_PANELS_KEY] as TabPanelMap) ?? {};
  return map[String(tabId)]?.threadId ?? null;
}

/**
 * What a change of the tab → chat map means for one tab's panel showing `current`:
 * - `show`: the tab has a chat now that the panel does not show (opened from elsewhere, or after a restart)
 * - `moved`: the chat the panel shows went to live on another tab, so this tab has none
 * - `cleared`: the tab lost its chat another way (deleted)
 * - null: nothing to do
 */
export function tabChange(
  tabId: number,
  current: string | null,
  before: TabPanelMap | undefined,
  after: TabPanelMap | undefined,
): { kind: 'show'; threadId: string } | { kind: 'moved' | 'cleared' } | null {
  const was = before?.[String(tabId)]?.threadId ?? null;
  const now = after?.[String(tabId)]?.threadId ?? null;
  if (was === now) return null;
  if (now !== null) return now === current ? null : { kind: 'show', threadId: now };
  if (current === null || was !== current) return null;
  const elsewhere = Object.values(after ?? {}).some(entry => entry.threadId === current && entry.role === 'home');
  return { kind: elsewhere ? 'moved' : 'cleared' };
}

/** Where a past chat belongs, for the list on a new tab: the site of its page, or nothing. */
export function pageOf(thread: Pick<ThreadRecord, 'boundUrl'>): string {
  if (!thread.boundUrl || !/^https?:/i.test(thread.boundUrl)) return '';
  try {
    const url = new URL(thread.boundUrl);
    const path = url.pathname === '/' ? '' : url.pathname;
    const short = path.length > 24 ? `${path.slice(0, 23)}…` : path;
    return `${url.hostname.replace(/^www\./, '')}${short}`;
  } catch {
    return '';
  }
}

/**
 * Keeps the panel's chat in step with the tab → chat map: shows the tab's chat on opening, and follows changes made
 * from other tabs. `onChange` hears what happened.
 */
export function useTabThread(
  tabId: number | null,
  threadId: string | null,
  onChange: (change: { kind: 'show'; threadId: string } | { kind: 'moved' | 'cleared' }) => void,
): void {
  const current = useRef(threadId);
  current.current = threadId;
  const handler = useRef(onChange);
  handler.current = onChange;

  useEffect(() => {
    if (tabId === null) return;
    void threadOnTab(tabId).then(id => {
      if (id && id !== current.current) handler.current({ kind: 'show', threadId: id });
    });
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'session' || !changes[TAB_PANELS_KEY]) return;
      const change = tabChange(
        tabId,
        current.current,
        changes[TAB_PANELS_KEY].oldValue as TabPanelMap | undefined,
        changes[TAB_PANELS_KEY].newValue as TabPanelMap | undefined,
      );
      if (change) handler.current(change);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [tabId]);
}
