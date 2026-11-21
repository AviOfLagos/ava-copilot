/** What a tab watcher's probe reads from the page: never more than visible text. */
export interface WatcherConversation {
  // Stable within the source, so the same conversation never lands twice; built from whatever the
  // page exposes (a data attribute, a link), never a guess that could collide
  externalId: string;
  sender: string;
  snippet: string;
  // What the page shows of who the sender is, for people (src/background/people): Gmail's address, Slack's DM id
  senderEmail?: string;
  senderHandle?: string;
  // A direct message from one person, not a channel or a group
  isPerson?: boolean;
}

export interface Watcher {
  // "whatsapp-web" | "slack-web" | "gmail-web"
  source: string;
  settingKey: 'watchWhatsapp' | 'watchSlack' | 'watchGmail';
  // Which open tabs this watcher may read
  matchesUrl: (url: string) => boolean;
  // Self-contained: runs in the page via chrome.scripting.executeScript, so it must not reference
  // anything outside its own body (see CLAUDE.md on page-injected functions).
  probe: () => WatcherConversation[];
}
