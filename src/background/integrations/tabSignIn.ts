import { t } from '@extension/i18n';
import { toAppError } from '@extension/shared';
import { threadStore } from '@extension/storage';
import { createLogger } from '../log';
import type { ConnectorService } from './service';

/**
 * Signing in to a connector in an ordinary tab, for the guided setup: the service's sign-in page opens next to
 * the user's other tabs, they log in and approve it themselves, and the service sends the tab to
 * https://<extension id>.chromiumapp.org/ — a host that does not resolve, so nothing leaves the browser. The
 * background sees that address on the tab it opened, closes the tab and finishes the sign-in (the PKCE verifier
 * and state wait in session storage, so a background stopped meanwhile loses nothing).
 *
 * Only tabs this file opened are watched, and the answer must still carry a state the background started.
 */

const logger = createLogger('Connectors');
const KEY = 'conn-signin-tabs';
// A sign-in left this long is forgotten (the pending state expires at the same time)
const TTL_MS = 15 * 60_000;

interface PendingTab {
  connectorId: string;
  threadId: string | null;
  startedAt: number;
}

type Pending = Record<string, PendingTab>;

async function load(): Promise<Pending> {
  return ((await chrome.storage.session.get(KEY))[KEY] as Pending | undefined) ?? {};
}

async function save(pending: Pending): Promise<void> {
  await chrome.storage.session.set({ [KEY]: pending });
}

/** Addresses in an error can carry a sign-in code or token: only their site is kept. */
export function redactAddresses(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, address => {
    try {
      return `${new URL(address).origin}/…`;
    } catch {
      return '…';
    }
  });
}

/**
 * Outside text (a server's name or error) as a short quoted phrase on one line: the chat's system lines reach the
 * model, so it must read as data, not as another line of instructions.
 */
export function quoted(text: string, max = 160): string {
  const flat = redactAddresses(text)
    // eslint-disable-next-line no-control-regex -- control characters are what is removed
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/["“”<>`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return `"${flat.length > max ? `${flat.slice(0, max)}…` : flat}"`;
}

/** Tells the chat that asked how the sign-in went. */
async function tell(threadId: string | null, text: string): Promise<void> {
  if (threadId) await threadStore.addMessage(threadId, 'system', text).catch(() => {});
}

/**
 * Opens the connector's sign-in page in a tab and watches it. A sign-in tab already open for it is brought
 * forward instead of opening another.
 *
 * @returns The sign-in page's address
 */
export async function openSignInTab(
  service: ConnectorService,
  connectorId: string,
  threadId: string | null,
): Promise<string> {
  const pending = await load();
  for (const [tabId, entry] of Object.entries(pending)) {
    if (entry.connectorId !== connectorId || Date.now() - entry.startedAt > TTL_MS) continue;
    const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
    if (tab?.id !== undefined) {
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      return tab.url ?? '';
    }
  }
  const { authorizationUrl } = await service.beginSignIn(connectorId);
  const tab = await chrome.tabs.create({ url: authorizationUrl, active: true });
  if (tab.id === undefined) throw new Error('The sign-in tab did not open.');
  const now = Date.now();
  const kept = Object.fromEntries(Object.entries(pending).filter(([, entry]) => now - entry.startedAt <= TTL_MS));
  await save({ ...kept, [String(tab.id)]: { connectorId, threadId, startedAt: now } });
  return authorizationUrl;
}

// Tabs being finished right now: the same address is reported by more than one event
const finishing = new Set<number>();

async function onAddress(service: ConnectorService, tabId: number, url: string | undefined): Promise<void> {
  if (!url || finishing.has(tabId)) return;
  let redirect: string;
  try {
    redirect = chrome.identity.getRedirectURL();
  } catch {
    return;
  }
  if (!url.startsWith(redirect)) return;
  // Claimed before anything is awaited: the same answer comes in through two or three events at once
  finishing.add(tabId);
  try {
    const pending = await load();
    const entry = pending[String(tabId)];
    if (!entry) return;
    delete pending[String(tabId)];
    await save(pending);
    await chrome.tabs.remove(tabId).catch(() => {});
    const connector = await service.get(entry.connectorId);
    const name = quoted(connector?.name ?? '', 60);
    try {
      const finished = await service.finishSignIn(url);
      await tell(
        entry.threadId,
        finished.summary
          ? t('conn_setup_signedIn', [name, String(finished.summary.tools)])
          : t('conn_signIn_doneNoTools', [quoted(finished.error ?? '')]),
      );
    } catch (error) {
      const message = redactAddresses(toAppError(error).message);
      logger.warning(`Sign-in in a tab did not finish (${toAppError(error).kind})`);
      await service.noteSignInFailure(entry.connectorId, message).catch(() => {});
      await tell(entry.threadId, t('conn_setup_signInFailed', [name, quoted(message)]));
    }
  } finally {
    finishing.delete(tabId);
  }
}

/** Watches the tabs the guided setup opened for the service's answer. Registered at startup. */
export function watchSignInTabs(service: ConnectorService): void {
  chrome.tabs.onUpdated.addListener((tabId, change) => void onAddress(service, tabId, change.url));
  // A host that does not resolve ends in an error: its address is the answer
  chrome.webNavigation.onErrorOccurred.addListener(details => {
    if (details.frameId === 0) void onAddress(service, details.tabId, details.url);
  });
  chrome.webNavigation.onCommitted.addListener(details => {
    if (details.frameId === 0) void onAddress(service, details.tabId, details.url);
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    if (finishing.has(tabId)) return;
    void load().then(pending => {
      if (!pending[String(tabId)]) return;
      delete pending[String(tabId)];
      return save(pending);
    });
  });
}
