import { t } from '@extension/i18n';
import { toAppError } from '@extension/shared';
import { connectorCatalogEntry, connectorToolState, CONNECTOR_CATALOG_IDS } from '@extension/storage';
import type { ConnectorCatalogId, ConnectorRecord, ToolFingerprint, VaultState } from '@extension/storage';

/**
 * "Set it up with Ava": a guided setup for a connection, one step at a time. Each call looks at where things
 * stand and does the next thing it can do itself — add the connector, open the service's sign-in or developer
 * page in a tab — then says what is left for the user. Calling it again carries on from there.
 *
 * What it never does: type a password, a token or a client secret (those go into the panel's fields, straight to
 * the vault), or press a consent / authorize button. The sign-in tab is the user's: the agent's tabs are bound
 * to its chat, and this one is not.
 */

export const SETUP_TARGETS = [...CONNECTOR_CATALOG_IDS, 'custom', 'obsidian', 'models'] as const;
export type SetupTarget = (typeof SETUP_TARGETS)[number];

export type SetupStage =
  // Connectors
  | 'needs_url'
  | 'needs_client'
  | 'needs_token'
  | 'signing_in'
  | 'review_tools'
  | 'turned_off'
  | 'not_working'
  | 'done'
  // Obsidian
  | 'obsidian_enable'
  | 'obsidian_pick'
  | 'obsidian_allow'
  // Models
  | 'models_key';

export interface SetupStep {
  target: SetupTarget;
  stage: SetupStage;
  // What Ava says to the user: plain words, never a secret
  say: string;
  // Pages opened for the user in this step
  opened: string[];
  connectorId: string | null;
  done: boolean;
}

export interface SetupRequest {
  target: SetupTarget;
  // The workspace a new connector serves (the chat's, else the default)
  workspaceId?: string | null;
  // A custom server's address and name
  url?: string;
  name?: string;
  // A model provider for target 'models'
  provider?: string;
  // The chat that asked, told when a sign-in in a tab finishes
  threadId?: string | null;
  // Whether to open pages (false: only say what would come next)
  open?: boolean;
}

export interface SetupDeps {
  connectors: {
    list(): Promise<ConnectorRecord[]>;
    get(id: string): Promise<ConnectorRecord | undefined>;
    // Adds it and reads its tools when no sign-in is needed (a server that wants one is switched to signing in)
    addAndConnect(input: {
      name: string;
      url?: string;
      authKind?: ConnectorRecord['authKind'];
      workspaceIds: string[];
      catalogId?: ConnectorCatalogId | null;
    }): Promise<{ connector: ConnectorRecord }>;
    tools(id: string): Promise<ToolFingerprint[]>;
  };
  // Opens the sign-in page of an OAuth connector in a tab and watches for its answer
  openSignIn(connectorId: string, threadId: string | null): Promise<string>;
  openTab(url: string): Promise<void>;
  defaultWorkspaceId(): Promise<string | null>;
  redirectUrl(): string;
  vaultState(): Promise<VaultState>;
  // Nex Brain is paired: it reaches the vault on the Mac, with no folder picker or Brave flag
  brainPaired?(): Promise<boolean>;
  isBrave(): boolean;
  providerHasKey(provider: string): Promise<boolean>;
  // The extension's own Models page
  modelsPageUrl(): string;
}

// Where a token or an OAuth client is made for each well-known service
const DEVELOPER_PAGES: Partial<Record<ConnectorCatalogId, string>> = {
  github: 'https://github.com/settings/personal-access-tokens/new',
  slack: 'https://api.slack.com/apps',
  gmail: 'https://console.cloud.google.com/apis/credentials',
  google_calendar: 'https://console.cloud.google.com/apis/credentials',
  google_drive: 'https://console.cloud.google.com/apis/credentials',
};

// Where each model provider hands out keys
export const PROVIDER_KEY_PAGES: Record<string, string> = {
  gemini: 'https://aistudio.google.com/apikey',
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  openrouter: 'https://openrouter.ai/keys',
  groq: 'https://console.groq.com/keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
  grok: 'https://console.x.ai',
};

export const BRAVE_FLAG_URL = 'brave://flags/#file-system-access-api';

export function isSetupTarget(value: string): value is SetupTarget {
  return (SETUP_TARGETS as readonly string[]).includes(value);
}

/** The setup target a few words name: "linear", "Google Calendar", "obsidian vault", "a model key". */
export function setupTargetFrom(words: string): SetupTarget | null {
  const text = words.toLowerCase();
  if (/obsidian|vault/.test(text)) return 'obsidian';
  if (/calendar/.test(text)) return 'google_calendar';
  if (/drive/.test(text)) return 'google_drive';
  if (/gmail|e-?mail/.test(text)) return 'gmail';
  if (/model|api key|llm/.test(text)) return 'models';
  if (/si[- _]?sdk|social|bluesky|mastodon/.test(text)) return 'si_sdk';
  for (const id of CONNECTOR_CATALOG_IDS) if (text.includes(id)) return id;
  if (/https?:\/\/|custom|mcp/.test(text)) return 'custom';
  return null;
}

export class ConnectionSetup {
  constructor(private readonly deps: SetupDeps) {}

  /** The next step of setting up `target`, doing what can be done without the user. */
  async advance(request: SetupRequest): Promise<SetupStep> {
    if (request.target === 'obsidian') return this.obsidian(request);
    if (request.target === 'models') return this.models(request);
    return this.connector(request);
  }

  private step(
    request: SetupRequest,
    stage: SetupStage,
    say: string,
    opened: string[] = [],
    connectorId: string | null = null,
  ): SetupStep {
    return { target: request.target, stage, say, opened, connectorId, done: stage === 'done' };
  }

  private async open(request: SetupRequest, urls: string[]): Promise<string[]> {
    if (request.open === false) return [];
    for (const url of urls) await this.deps.openTab(url);
    return urls;
  }

  // ── Connectors ──────────────────────────────────────────────────────────────────────────────

  private async find(request: SetupRequest): Promise<ConnectorRecord | undefined> {
    const all = await this.deps.connectors.list();
    if (request.target === 'custom') {
      const url = request.url?.trim();
      return url ? all.find(connector => connector.url === url || connector.url === new URL(url).href) : undefined;
    }
    return all.find(connector => connector.catalogId === request.target);
  }

  private async connector(request: SetupRequest): Promise<SetupStep> {
    const entry = connectorCatalogEntry(request.target);
    let connector: ConnectorRecord | undefined;
    try {
      connector = await this.find(request);
    } catch {
      return this.step(request, 'needs_url', t('conn_setup_needsUrl'));
    }

    if (!connector) {
      if (request.target === 'custom' && !request.url?.trim()) {
        return this.step(request, 'needs_url', t('conn_setup_needsUrl'));
      }
      // A service that needs the user's own app: Ava opens the page where it is made; the IDs go in the panel
      if (entry?.needsClient) {
        const opened = await this.open(request, [DEVELOPER_PAGES[entry.id] ?? entry.docsUrl, entry.docsUrl]);
        return this.step(
          request,
          'needs_client',
          t('conn_setup_needsClient', [entry.name, this.deps.redirectUrl()]),
          opened,
        );
      }
      const workspaceId = request.workspaceId ?? (await this.deps.defaultWorkspaceId());
      try {
        ({ connector } = await this.deps.connectors.addAndConnect({
          name: entry?.name ?? request.name?.trim() ?? '',
          url: entry && !entry.ownServer ? undefined : request.url?.trim(),
          // A custom server is tried with no sign-in first; one that asks for it is switched to signing in
          authKind: entry ? undefined : 'none',
          catalogId: entry?.id ?? null,
          workspaceIds: workspaceId ? [workspaceId] : [],
        }));
      } catch (error) {
        return this.step(request, 'not_working', toAppError(error).message);
      }
    }
    return this.forConnector(request, connector);
  }

  private async forConnector(request: SetupRequest, connector: ConnectorRecord): Promise<SetupStep> {
    const entry = connectorCatalogEntry(connector.catalogId);
    const id = connector.id;
    switch (connector.status) {
      case 'disabled':
        return this.step(request, 'turned_off', t('conn_setup_turnedOff', [connector.name]), [], id);
      case 'needs_auth': {
        if (connector.authKind === 'token') {
          const page = (entry && DEVELOPER_PAGES[entry.id]) ?? entry?.docsUrl;
          const opened = page ? await this.open(request, [page]) : [];
          return this.step(request, 'needs_token', t('conn_setup_needsToken', [connector.name]), opened, id);
        }
        if (connector.authKind === 'oauth') {
          if (entry?.needsClient && !connector.oauth?.clientId) {
            const opened = await this.open(request, [DEVELOPER_PAGES[entry.id] ?? entry.docsUrl]);
            return this.step(
              request,
              'needs_client',
              t('conn_setup_needsClient', [connector.name, this.deps.redirectUrl()]),
              opened,
              id,
            );
          }
          if (request.open === false) {
            return this.step(request, 'signing_in', t('conn_setup_signIn', [connector.name]), [], id);
          }
          try {
            // Only the sign-in page's site: its address carries the sign-in's state, which is not the model's to see
            const url = await this.deps.openSignIn(id, request.threadId ?? null);
            return this.step(request, 'signing_in', t('conn_setup_signIn', [connector.name]), [siteOf(url)], id);
          } catch (error) {
            return this.step(request, 'not_working', toAppError(error).message, [], id);
          }
        }
        return this.step(request, 'not_working', connector.lastError ?? t('conn_status_needsAuth'), [], id);
      }
      case 'error':
        return this.step(
          request,
          'not_working',
          t('conn_setup_notWorking', [connector.name, connector.lastError ?? '']),
          [],
          id,
        );
      default: {
        const tools = (await this.deps.connectors.tools(id)).filter(tool => !tool.missing);
        const waiting = tools.filter(tool => connectorToolState(tool) !== 'ok').length;
        if (waiting) {
          return this.step(
            request,
            'review_tools',
            t('conn_setup_reviewTools', [connector.name, String(tools.length), String(waiting)]),
            [],
            id,
          );
        }
        return this.step(request, 'done', t('conn_setup_done', [connector.name, String(tools.length)]), [], id);
      }
    }
  }

  // ── Obsidian ────────────────────────────────────────────────────────────────────────────────

  private async obsidian(request: SetupRequest): Promise<SetupStep> {
    const vault = await this.deps.vaultState();
    if (vault.name && vault.access === 'granted') {
      return this.step(request, 'done', t('conn_setup_obsidianDone', [vault.name]));
    }
    if (vault.name) return this.step(request, 'obsidian_allow', t('conn_setup_obsidianAllow', [vault.name]));
    if (await this.deps.brainPaired?.().catch(() => false)) {
      return this.step(request, 'obsidian_pick', t('conn_setup_obsidianBrain'));
    }
    const braveOff = vault.support === 'brave_off' || (vault.support === null && this.deps.isBrave());
    if (braveOff) {
      const opened = await this.open(request, [BRAVE_FLAG_URL]);
      return this.step(request, 'obsidian_enable', t('conn_setup_obsidianBrave'), opened);
    }
    return this.step(request, 'obsidian_pick', t('conn_setup_obsidianPick'));
  }

  // ── Models ──────────────────────────────────────────────────────────────────────────────────

  private async models(request: SetupRequest): Promise<SetupStep> {
    const provider = request.provider && PROVIDER_KEY_PAGES[request.provider] ? request.provider : 'gemini';
    if (await this.deps.providerHasKey(provider)) {
      return this.step(request, 'done', t('conn_setup_modelsDone', [provider]));
    }
    const opened = await this.open(request, [PROVIDER_KEY_PAGES[provider], this.deps.modelsPageUrl()]);
    return this.step(request, 'models_key', t('conn_setup_modelsKey', [provider]), opened);
  }
}

/** "https://linear.app" for a sign-in page's full address. */
export function siteOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
