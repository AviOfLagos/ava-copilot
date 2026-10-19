/**
 * Opens the full-page Settings at a page or section (`#voice/engines`): the tab already showing it moves there
 * (its hash changes, nothing reloads) and comes to the front, else a new tab opens. Used by the side panel's
 * "more" links and by Ava's open_place, so there is only ever one Settings tab.
 */

export const SETTINGS_PAGE_PATH = 'options.html';

export function settingsPageUrl(hash = ''): string {
  const base = chrome.runtime.getURL(SETTINGS_PAGE_PATH);
  return hash ? `${base}${hash.startsWith('#') ? hash : `#${hash}`}` : base;
}

/** Whether a tab's address is the Settings page (with or without a hash). */
export function isSettingsPageUrl(url: string | undefined, base: string): boolean {
  return Boolean(url && (url === base || url.startsWith(`${base}#`) || url.startsWith(`${base}?`)));
}

export async function openSettingsPage(hash = ''): Promise<void> {
  const base = chrome.runtime.getURL(SETTINGS_PAGE_PATH);
  const url = settingsPageUrl(hash);
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  const open = tabs.find(tab => isSettingsPageUrl(tab.url, base));
  if (open?.id !== undefined) {
    await chrome.tabs.update(open.id, { url, active: true });
    if (open.windowId !== undefined) await chrome.windows.update(open.windowId, { focused: true }).catch(() => {});
    return;
  }
  await chrome.tabs.create({ url });
}
