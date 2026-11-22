import { t } from '@extension/i18n';
import { AppError } from '@extension/shared';
import { onceStore, recordingSettingsStore, recordingStore, taskStore, workspaceStore } from '@extension/storage';
import { brainSettingsStore } from '../companion/state';
import { companionClient } from '../companion/client';
import { addInboxItem } from '../inbox/store';
import { connectorStore, oauthManager } from '../integrations/instance';
import { DriveRecordings } from './drive';
import type { SaveDeps } from './save';
import type { ShareDeps } from './share';

/** The real dependencies of saving and sharing: the connector's token, Ava Brain, the task board and the Inbox. */

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** The Drive client, when the `google_drive` connector is signed in; null when it was never connected. */
export async function driveClient(): Promise<DriveRecordings | null> {
  const connector = (await connectorStore.list()).find(
    item => item.catalogId === 'google_drive' && item.authKind === 'oauth' && item.status !== 'disabled',
  );
  if (!connector) return null;
  const tokens = await oauthManager.tokens(connector.id);
  if (!tokens?.access_token) return null;
  // A token Google gave without file access cannot upload; only connecting again with it helps
  if (tokens.scope && !tokens.scope.split(/\s+/).includes(DRIVE_FILE_SCOPE)) {
    throw new AppError('auth', 'Google Drive is connected without file access. Connect it again in Connectors.', {
      retryable: false,
    });
  }
  return new DriveRecordings({
    fetch: (input, init) => fetch(input, init),
    token: () => oauthManager.accessToken(connector),
    renew: used => oauthManager.renewAfterRefusal(connector, used),
  });
}

async function nudgeDrive(): Promise<void> {
  const settings = await recordingSettingsStore.getSettings();
  if (settings.driveNudged) return;
  await recordingSettingsStore.updateSettings({ driveNudged: true });
  await addInboxItem({
    source: 'system',
    externalId: 'recordings-connect-drive',
    kind: 'alert',
    title: t('recording_inbox_drive_title'),
    body: t('recording_inbox_drive_body'),
    links: [{ label: t('recording_inbox_drive_link'), url: chrome.runtime.getURL('options.html#connections') }],
    priority: 'low',
    workspaceId: null,
    agentId: null,
  });
}

export const saveDeps: SaveDeps = {
  store: recordingStore,
  once: onceStore,
  drive: driveClient,
  brain: {
    paired: async () => (await brainSettingsStore.getSettings()).paired,
    recordingBegin: request => companionClient.recordingBegin(request),
    recordingChunk: (uploadId, index, data) => companionClient.recordingChunk(uploadId, index, data),
    recordingCommit: uploadId => companionClient.recordingCommit(uploadId),
  },
  workspaceName: async id => (await workspaceStore.get(id))?.name ?? null,
  nudgeDrive,
};

export const shareDeps: ShareDeps = {
  store: recordingStore,
  once: onceStore,
  drive: driveClient,
  tasks: {
    addLink: async (taskId, link) => void (await taskStore.addLink(taskId, link)),
    removeLink: async (taskId, url) => void (await taskStore.removeLink(taskId, url)),
  },
};
