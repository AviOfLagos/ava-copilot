import { t } from '@extension/i18n';
import type { ConnectorCatalogId, ConnectorRecord } from '@extension/storage';

type MessageKey = Parameters<typeof t>[0];

export const STATUS_LABEL: Record<ConnectorRecord['status'], MessageKey> = {
  connected: 'conn_status_connected',
  needs_auth: 'conn_status_needsAuth',
  error: 'conn_status_error',
  disabled: 'conn_status_disabled',
};

export function statusTone(status: ConnectorRecord['status']): string {
  switch (status) {
    case 'connected':
      return 'bg-primary shadow-[0_0_8px_rgb(var(--primary-rgb))]';
    case 'error':
      return 'bg-destructive';
    case 'needs_auth':
      // Waits for the user to sign in: the one place amber says "your click"
      return 'bg-hold';
    default:
      return 'bg-muted-foreground/50';
  }
}

// How to sign in to each well-known server, in a line
export const CATALOG_HOW: Record<ConnectorCatalogId, MessageKey> = {
  github: 'conn_catalog_github',
  linear: 'conn_catalog_signIn',
  notion: 'conn_catalog_signIn',
  slack: 'conn_catalog_slack',
  gmail: 'conn_catalog_google',
  google_calendar: 'conn_catalog_google',
  google_drive: 'conn_catalog_google',
};

const ERROR_TEXT: Record<string, MessageKey> = {
  auth: 'conn_error_auth',
  forbidden: 'conn_error_forbidden',
  not_found: 'conn_error_notFound',
  rate_limit: 'conn_error_rateLimit',
  timeout: 'conn_error_timeout',
  network: 'conn_error_network',
  unavailable: 'conn_error_unavailable',
  invalid: 'conn_error_invalid',
};

/** What went wrong last, in the user's language when the kind is known. */
export function lastErrorText(connector: ConnectorRecord): string | null {
  if (!connector.lastError) return null;
  const key = connector.lastErrorKind ? ERROR_TEXT[connector.lastErrorKind] : undefined;
  return key ? t(key, [connector.name]) : connector.lastError;
}

export function hostOf(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
