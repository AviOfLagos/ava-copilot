import { focusLine, TabTracker } from './tabs';

/** The background's one tab tracker; its listeners are added in ./register.ts at startup. */
export const tabTracker = new TabTracker({
  tabs: chrome.tabs,
  windows: chrome.windows,
  session: chrome.storage.session,
});

/** "The user's tab in front: … (previous: …)", or '' before anything was seen. */
export function currentTabLine(): string {
  return focusLine(tabTracker.state);
}
