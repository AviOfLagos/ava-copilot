/**
 * Well-known services with an official remote MCP server, each checked against the service's own public docs
 * (2026-10-12). Anything else is added as a custom server by its address.
 */

export const CONNECTOR_CATALOG_IDS = [
  'github',
  'linear',
  'notion',
  'slack',
  'gmail',
  'google_calendar',
  'google_drive',
] as const;
export type ConnectorCatalogId = (typeof CONNECTOR_CATALOG_IDS)[number];

export interface ConnectorCatalogEntry {
  id: ConnectorCatalogId;
  name: string;
  url: string;
  // How the user signs in: a token they paste, or the service's sign-in page
  auth: 'token' | 'oauth';
  // The service does not register Nex Copilot by itself: the user brings a client ID (and secret) of their own
  needsClient: boolean;
  // Scopes to ask for, when the service's docs name the ones its MCP server needs
  scope?: string;
  // Extra parameters the service's sign-in page needs
  authParams?: Record<string, string>;
  docsUrl: string;
}

// Google gives a refresh token only to a client that asks for offline access, and again only on a fresh consent
const GOOGLE_AUTH_PARAMS = { access_type: 'offline', prompt: 'consent' };

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  {
    // OAuth there uses GitHub's own pre-registered apps, so another client signs in with a personal access token
    id: 'github',
    name: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: 'token',
    needsClient: false,
    docsUrl: 'https://github.com/github/github-mcp-server',
  },
  {
    // OAuth 2.1 with dynamic client registration
    id: 'linear',
    name: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
    needsClient: false,
    docsUrl: 'https://linear.app/docs/mcp',
  },
  {
    // OAuth only, with dynamic client registration
    id: 'notion',
    name: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    auth: 'oauth',
    needsClient: false,
    docsUrl: 'https://developers.notion.com/docs/get-started-with-mcp',
  },
  {
    // Confidential OAuth with the user's own internal or directory-published Slack app; no dynamic registration
    id: 'slack',
    name: 'Slack',
    url: 'https://mcp.slack.com/mcp',
    auth: 'oauth',
    needsClient: true,
    docsUrl: 'https://docs.slack.dev/ai/slack-mcp-server/',
  },
  {
    // A "Web application" OAuth client the user makes in Google Cloud; scopes from Google's setup guide
    id: 'gmail',
    name: 'Gmail',
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    auth: 'oauth',
    needsClient: true,
    scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',
    authParams: GOOGLE_AUTH_PARAMS,
    docsUrl: 'https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server',
  },
  {
    id: 'google_calendar',
    name: 'Google Calendar',
    url: 'https://calendarmcp.googleapis.com/mcp/v1',
    auth: 'oauth',
    needsClient: true,
    scope:
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.events.readonly',
    authParams: GOOGLE_AUTH_PARAMS,
    docsUrl: 'https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server',
  },
  {
    id: 'google_drive',
    name: 'Google Drive',
    url: 'https://drivemcp.googleapis.com/mcp/v1',
    auth: 'oauth',
    needsClient: true,
    scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file',
    authParams: GOOGLE_AUTH_PARAMS,
    docsUrl: 'https://developers.google.com/workspace/drive/api/guides/configure-mcp-server',
  },
];

export function connectorCatalogEntry(id: string | null | undefined): ConnectorCatalogEntry | undefined {
  return CONNECTOR_CATALOG.find(entry => entry.id === id);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Checks a server address: https, or plain http only to this computer (a token must never cross a network
 * unencrypted). No user name or password in the address.
 *
 * @returns The address as a URL, or a reason it cannot be used
 */
export function checkConnectorUrl(raw: string): { url: URL } | { error: 'invalid' | 'insecure' | 'credentials' } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: 'invalid' };
  }
  if (url.username || url.password) return { error: 'credentials' };
  if (url.protocol === 'https:') return { url };
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return { url };
  return { error: url.protocol === 'http:' ? 'insecure' : 'invalid' };
}
