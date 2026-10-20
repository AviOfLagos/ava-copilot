import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorRecord, ToolFingerprint, VaultState } from '@extension/storage';

vi.hoisted(() => {
  vi.stubGlobal('chrome', {
    storage: { local: { get: async () => ({}), set: async () => {}, onChanged: { addListener: () => {} } } },
    // The key and its placeholders, so the tests can see which words were chosen
    i18n: { getMessage: (key: string, subs?: string[]) => [key, ...(subs ?? [])].join('|') },
  });
});

const { ConnectionSetup, setupTargetFrom } = await import('../setup');
const { describeStep } = await import('../setupAction');
import { connectorRecord } from './fakes';

let connectors: ConnectorRecord[];
let tools: ToolFingerprint[];
let opened: string[];
let signIns: { connectorId: string; threadId: string | null }[];
let vault: VaultState;
let brave: boolean;
let keys: Set<string>;
let added: Parameters<ConstructorParameters<typeof ConnectionSetup>[0]['connectors']['addAndConnect']>[0][];

function setup() {
  return new ConnectionSetup({
    connectors: {
      list: async () => connectors,
      get: async id => connectors.find(connector => connector.id === id),
      addAndConnect: async input => {
        added.push(input);
        const connector = connectorRecord({
          id: `new-${added.length}`,
          name: input.name,
          catalogId: input.catalogId ?? null,
          url: input.url ?? 'https://mcp.linear.app/mcp',
          authKind: input.catalogId === 'github' ? 'token' : input.catalogId ? 'oauth' : (input.authKind ?? 'none'),
          status: input.catalogId ? 'needs_auth' : 'connected',
          workspaceIds: input.workspaceIds,
        });
        connectors.push(connector);
        return { connector };
      },
      tools: async () => tools,
    },
    openSignIn: async (connectorId, threadId) => {
      signIns.push({ connectorId, threadId });
      return 'https://auth.example/authorize';
    },
    openTab: async url => {
      opened.push(url);
    },
    defaultWorkspaceId: async () => 'w-default',
    redirectUrl: () => 'https://ext.chromiumapp.org/',
    vaultState: async () => vault,
    isBrave: () => brave,
    providerHasKey: async provider => keys.has(provider),
    modelsPageUrl: () => 'chrome-extension://ext/options.html',
  });
}

const fingerprint = (tool: string, approved: boolean): ToolFingerprint =>
  ({
    id: `c:${tool}`,
    connectorId: 'c1',
    tool,
    hash: 'a'.repeat(64),
    approved,
    approvedHash: approved ? 'a'.repeat(64) : null,
    missing: false,
  }) as unknown as ToolFingerprint;

beforeEach(() => {
  connectors = [];
  tools = [];
  opened = [];
  signIns = [];
  vault = { support: 'ok', name: null, access: null };
  brave = false;
  keys = new Set();
  added = [];
});

describe('setting up a connector with Ava', () => {
  it('adds a sign-in server to the chat’s workspace and opens its sign-in in a tab for the user', async () => {
    const step = await setup().advance({ target: 'linear', workspaceId: 'w1', threadId: 't1' });
    expect(added).toEqual([expect.objectContaining({ catalogId: 'linear', workspaceIds: ['w1'] })]);
    expect(signIns).toEqual([{ connectorId: 'new-1', threadId: 't1' }]);
    expect(step).toMatchObject({ stage: 'signing_in', done: false, opened: ['https://auth.example'] });
    // The agent is told to leave the page to the user and to come back
    const words = describeStep(step);
    expect(words).toContain('Leave those tabs to them');
    expect(words).toContain('call set_up_connection again');
  });

  it('falls back to the default workspace, and never adds a second one on the next step', async () => {
    const guide = setup();
    await guide.advance({ target: 'notion' });
    expect(added[0].workspaceIds).toEqual(['w-default']);
    connectors[0].status = 'connected';
    tools = [fingerprint('search', false), fingerprint('fetch', false)];
    const step = await guide.advance({ target: 'notion' });
    expect(added).toHaveLength(1);
    expect(step).toMatchObject({ stage: 'review_tools', connectorId: 'new-1' });
    tools = tools.map(tool => ({ ...tool, approved: true, approvedHash: tool.hash }));
    expect(await guide.advance({ target: 'notion' })).toMatchObject({ stage: 'done', done: true });
  });

  it('opens the token page for a token service, and asks for the token in the panel, not the chat', async () => {
    const step = await setup().advance({ target: 'github' });
    expect(step.stage).toBe('needs_token');
    expect(opened).toEqual(['https://github.com/settings/personal-access-tokens/new']);
    expect(signIns).toEqual([]);
  });

  it('opens the developer console for a service that needs the user’s own client, with the redirect to register', async () => {
    const step = await setup().advance({ target: 'gmail' });
    expect(step.stage).toBe('needs_client');
    expect(step.say).toContain('https://ext.chromiumapp.org/');
    expect(opened[0]).toBe('https://console.cloud.google.com/apis/credentials');
    // Nothing is added until the user gives a client ID
    expect(added).toEqual([]);
  });

  it('asks for a custom server’s address, then adds it trying no sign-in first', async () => {
    expect((await setup().advance({ target: 'custom' })).stage).toBe('needs_url');
    const step = await setup().advance({ target: 'custom', url: 'https://tools.example/mcp' });
    expect(added[0]).toMatchObject({ url: 'https://tools.example/mcp', authKind: 'none' });
    expect(step.stage).toBe('done');
  });

  it('only looks, with open: false, never opening a page', async () => {
    connectors.push(connectorRecord({ catalogId: 'linear', authKind: 'oauth', status: 'needs_auth' }));
    const step = await setup().advance({ target: 'linear', open: false });
    expect(step.stage).toBe('signing_in');
    expect(signIns).toEqual([]);
    expect(opened).toEqual([]);
  });
});

describe('setting up Obsidian and model keys with Ava', () => {
  it('opens Brave’s folder-access setting when Brave keeps the picker off', async () => {
    vault = { support: 'brave_off', name: null, access: null };
    const step = await setup().advance({ target: 'obsidian' });
    expect(step.stage).toBe('obsidian_enable');
    expect(opened).toEqual(['brave://flags/#file-system-access-api']);
  });

  it('asks for the click that opens the picker, then for access again after a restart, then is done', async () => {
    expect((await setup().advance({ target: 'obsidian' })).stage).toBe('obsidian_pick');
    vault = { support: 'ok', name: 'Notes', access: 'prompt' };
    expect((await setup().advance({ target: 'obsidian' })).stage).toBe('obsidian_allow');
    vault = { support: 'ok', name: 'Notes', access: 'granted' };
    expect(await setup().advance({ target: 'obsidian' })).toMatchObject({ stage: 'done', done: true });
    expect(opened).toEqual([]);
  });

  it('opens the provider’s key page and the Models page, and is done once a key is saved', async () => {
    const step = await setup().advance({ target: 'models', provider: 'openai' });
    expect(step.stage).toBe('models_key');
    expect(opened).toEqual(['https://platform.openai.com/api-keys', 'chrome-extension://ext/options.html']);
    keys.add('openai');
    expect((await setup().advance({ target: 'models', provider: 'openai' })).done).toBe(true);
  });

  it('reads what to set up from a few words', () => {
    expect(setupTargetFrom('my Obsidian vault')).toBe('obsidian');
    expect(setupTargetFrom('Google Calendar')).toBe('google_calendar');
    expect(setupTargetFrom('linear')).toBe('linear');
    expect(setupTargetFrom('an API key for the model')).toBe('models');
    expect(setupTargetFrom('https://x.example/mcp')).toBe('custom');
    expect(setupTargetFrom('my social accounts')).toBe('si_sdk');
    expect(setupTargetFrom('SI-SDK')).toBe('si_sdk');
    expect(setupTargetFrom('the weather')).toBeNull();
  });
});
