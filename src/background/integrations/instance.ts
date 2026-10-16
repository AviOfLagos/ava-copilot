import {
  db,
  deleteSecret,
  getSecret,
  llmProviderStore,
  providerHasKey,
  putSecret,
  VAULT_STATE_KEY,
  workspaceStore,
} from '@extension/storage';
import type { VaultState } from '@extension/storage';
import { postReconnectAlert } from './alerts';
import { OAuthManager } from './oauth';
import type { SessionAreaLike } from './oauth';
import { ConnectorService } from './service';
import { ConnectionSetup } from './setup';
import { ConnectorStore } from './store';
import { openSignInTab } from './tabSignIn';

/** The background's one connector service, on the real database, vault and session storage. */

const vault = { get: getSecret, put: putSecret, delete: deleteSecret };

const session: SessionAreaLike = {
  get: async key => ((await chrome.storage.session.get(key)) ?? {}) as Record<string, unknown>,
  set: items => chrome.storage.session.set(items),
};

export const connectorStore = new ConnectorStore();

export const oauthManager = new OAuthManager({
  fetch: (input, init) => fetch(input, init),
  vault,
  session,
  // https://<extension id>.chromiumapp.org/ — the extension's ID is pinned, so this never changes
  redirectUri: () => chrome.identity.getRedirectURL(),
  connector: id => connectorStore.get(id),
});

export const connectorService = new ConnectorService({
  store: connectorStore,
  vault,
  oauth: oauthManager,
  alert: postReconnectAlert,
});

/** The guided setup ("Set it up with Ava"), on the same service. */
export const connectionSetup = new ConnectionSetup({
  connectors: {
    list: () => connectorService.list(),
    get: id => connectorService.get(id),
    addAndConnect: input => connectorService.addAndConnect(input),
    tools: id => db.toolFingerprints.where('connectorId').equals(id).toArray(),
  },
  openSignIn: (connectorId, threadId) => openSignInTab(connectorService, connectorId, threadId),
  openTab: async url => {
    await chrome.tabs.create({ url, active: true });
  },
  defaultWorkspaceId: () => workspaceStore.getDefaultWorkspaceId().catch(() => null),
  redirectUrl: () => chrome.identity.getRedirectURL(),
  vaultState: async () => {
    const kept = (await chrome.storage.local.get(VAULT_STATE_KEY))[VAULT_STATE_KEY] as VaultState | undefined;
    return kept ?? { support: null, name: null, access: null };
  },
  // Brave marks itself on navigator, in workers too
  isBrave: () => Boolean((navigator as Navigator & { brave?: unknown }).brave),
  providerHasKey: async provider => providerHasKey((await llmProviderStore.getAllProviders())[provider]),
  modelsPageUrl: () => chrome.runtime.getURL('options.html'),
});
