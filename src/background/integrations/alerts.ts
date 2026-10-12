import { t } from '@extension/i18n';
import type { ConnectorRecord } from '@extension/storage';
import { postToInbox } from '../workflows/inbox';

/**
 * Tells the user, in the Inbox, that a connector stopped working until they sign in again: its token was refused
 * or could not be renewed. One item per sign-in that died, so a connector that keeps failing does not pile up.
 */
export async function postReconnectAlert(connector: ConnectorRecord, reason: string): Promise<void> {
  await postToInbox({
    source: `connector:${connector.id}`,
    externalId: `reconnect:${connector.credential?.savedAt ?? connector.createdAt}`,
    kind: 'alert',
    title: t('conn_alert_reconnect_title', [connector.name]),
    body: `${t('conn_alert_reconnect_body', [connector.name])}\n\n${reason}`,
    priority: 'high',
    workspaceId: connector.workspaceIds[0] ?? null,
  });
}
