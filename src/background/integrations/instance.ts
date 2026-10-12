import { deleteSecret, getSecret, putSecret } from '@extension/storage';
import { postReconnectAlert } from './alerts';
import { OAuthManager } from './oauth';
import type { SessionAreaLike } from './oauth';
import { ConnectorService } from './service';
import { ConnectorStore } from './store';

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
