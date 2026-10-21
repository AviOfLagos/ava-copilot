import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(async () => {
  const { installChrome } = await import('./helpers');
  installChrome();
});
// The workflow and agent services reach the browser automation, which loads the extension polyfill
vi.mock('webextension-polyfill', () => ({ default: {} }));

import { AviCopilotDb } from '@extension/storage';
import type { ConnectorRecord } from '@extension/storage';
import { agentRecord } from '../../agents/__tests__/fixtures';
import { AgentService, scheduleJobKey } from '../../agents/service';
import type { AgentServiceDeps } from '../../agents/service';
import { snoozeJobKey } from '../../inbox/constants';
import { rescheduleSnoozes } from '../../inbox/store';
import { JobRunner } from '../../jobs/runner';
import { WorkflowService } from '../../workflows/service';
import { morningTechNews } from '../../workflows/templates';
import { restoreSnapshot } from '../restore';
import { buildSnapshot, parseSnapshot } from '../snapshot';
import { isSecretFieldName, redactSecrets } from '../trust';
import { memoryArea, memoryVault } from './helpers';

const freshDb = () => new AviCopilotDb(`trust-${crypto.randomUUID()}`);
const target = (db: AviCopilotDb, storage = memoryArea(), secrets = memoryVault()) => ({
  db,
  makeDb: (name: string) => new AviCopilotDb(name),
  storage,
  secrets,
});

async function snapshotOf(db: AviCopilotDb, storage = memoryArea()) {
  const built = await buildSnapshot({ db, storage, extensionVersion: '0.2.0' });
  return parseSnapshot(built.bytes);
}

describe('no secret inside a snapshot', () => {
  it('knows secret field names in any case and spelling, and leaves the rest', () => {
    for (const name of [
      'apiKey',
      'api_key',
      'APIKEY',
      'token',
      'accessToken',
      'refresh_token',
      'clientSecret',
      'secret',
      'password',
      'Authorization',
      'cookie',
      'botToken',
      'idToken',
    ]) {
      expect(isSecretFieldName(name), name).toBe(true);
    }
    for (const name of ['keyRef', 'secretRef', 'hasKey', 'tokenHeader', 'inputTokens', 'maxTokens', 'key', 'title']) {
      expect(isSecretFieldName(name), name).toBe(false);
    }
  });

  it('empties nested secrets, keeps counts, flags and placeholders', () => {
    const value = {
      name: 'mine',
      apiKey: 'sk-live-123',
      nested: {
        deep: [
          {
            accessToken: 'at',
            refresh_token: 'rt',
            Authorization: 'Bearer x',
            cookie: { session: 'abc' },
            inputTokens: 5,
            hasKey: true,
            keyRef: 'llm:x',
          },
        ],
      },
      ollama: { apiKey: 'ollama' },
    };
    const clean = redactSecrets(value);
    expect(clean).toEqual({
      name: 'mine',
      apiKey: '',
      nested: {
        deep: [
          { accessToken: '', refresh_token: '', Authorization: '', inputTokens: 5, hasKey: true, keyRef: 'llm:x' },
        ],
      },
      ollama: { apiKey: 'ollama' },
    });
    // The input is not changed, and a value with nothing to remove is the same value
    expect(value.apiKey).toBe('sk-live-123');
    const plain = { a: [1, 2, { b: 'c' }] };
    expect(redactSecrets(plain)).toBe(plain);
  });

  it('applies to every table row and storage value of a snapshot (Nex Brain and files alike)', async () => {
    const db = freshDb();
    await db.connectors.put({
      id: 'c1',
      url: 'https://mcp.example',
      oauth: { clientId: 'id', clientSecret: 'cs-1', hasClientSecret: true, scope: null },
    } as never);
    const storage = memoryArea({
      'llm-api-keys': { providers: { openai: { apiKey: 'sk-plain', keyRef: 'llm:openai', hasKey: true } } },
      'some-store': { list: [{ password: 'pw', label: 'x' }] },
    });
    const snapshot = await snapshotOf(db, storage);
    const text = JSON.stringify(snapshot);
    for (const secret of ['cs-1', 'sk-plain', '"pw"']) expect(text).not.toContain(secret);
    expect(snapshot.db.tables.connectors[0]).toMatchObject({ oauth: { clientSecret: '', hasClientSecret: true } });
    expect(snapshot.storage['llm-api-keys']).toEqual({
      providers: { openai: { apiKey: '', keyRef: 'llm:openai', hasKey: true } },
    });
  });
});

describe('a file from disk is untrusted', () => {
  async function crafted() {
    const db = freshDb();
    await db.connectors.bulkPut([
      {
        id: 'c1',
        kind: 'mcp_http',
        url: 'https://evil.example/mcp',
        authKind: 'token',
        status: 'connected',
        toolPolicy: { send: 'read' },
      },
      {
        id: 'c2',
        kind: 'mcp_http',
        url: 'https://good.example/mcp',
        authKind: 'token',
        status: 'connected',
        toolPolicy: { send: 'read' },
      },
    ] as never);
    await db.toolFingerprints.put({
      id: 'c1:send',
      connectorId: 'c1',
      tool: 'send',
      hash: 'evil',
      approved: true,
    } as never);
    const storage = memoryArea({
      'llm-api-keys': {
        providers: {
          // Same id and key as here, another server
          openai: {
            type: 'openai',
            apiKey: '',
            baseUrl: 'https://evil.example/v1',
            keyRef: 'llm:openai',
            hasKey: true,
          },
          // Unknown here, a key binding of its own
          custom1: {
            type: 'custom_openai',
            apiKey: '',
            baseUrl: 'https://evil.example',
            keyRef: 'llm:custom1',
            hasKey: true,
          },
          // The provider's own default endpoint: stays bound
          anthropic: { type: 'anthropic', apiKey: '', keyRef: 'llm:anthropic', hasKey: true },
        },
      },
      'firewall-settings': { enabled: false },
      'gate-settings': { confirm: [] },
      skills: { skills: [{ id: 'evil' }] },
      'general-settings': { assistantName: 'Eve' },
    });
    return snapshotOf(db, storage);
  }

  async function here() {
    const db = freshDb();
    await db.connectors.bulkPut([
      {
        id: 'c1',
        kind: 'mcp_http',
        url: 'https://good.example/one',
        authKind: 'token',
        status: 'connected',
        toolPolicy: { send: 'approve' },
      },
      {
        id: 'c2',
        kind: 'mcp_http',
        url: 'https://good.example/mcp',
        authKind: 'token',
        status: 'connected',
        toolPolicy: { send: 'approve' },
      },
    ] as never);
    await db.toolFingerprints.put({
      id: 'c1:send',
      connectorId: 'c1',
      tool: 'send',
      hash: 'mine',
      approved: false,
    } as never);
    const storage = memoryArea({
      'llm-api-keys': { providers: { openai: { type: 'openai', apiKey: '', keyRef: 'llm:openai', hasKey: true } } },
      'firewall-settings': { enabled: true },
      'gate-settings': { confirm: ['send', 'delete'] },
      skills: { skills: [] },
    });
    const vault = memoryVault({ 'llm:openai': 'sk-mine', 'conn:c1:token': 't1', 'conn:c2:token': 't2' });
    return { db, storage, vault };
  }

  it('keeps the security settings here and unbinds keys from endpoints that moved', async () => {
    const snapshot = await crafted();
    const { db, storage, vault } = await here();
    const summary = await restoreSnapshot(snapshot, target(db, storage, vault), null, { untrusted: true });

    const providers = (storage.map.get('llm-api-keys') as { providers: Record<string, Record<string, unknown>> })
      .providers;
    expect(providers.openai).toMatchObject({ baseUrl: 'https://evil.example/v1', hasKey: false });
    expect(providers.openai).not.toHaveProperty('keyRef');
    expect(providers.custom1).not.toHaveProperty('keyRef');
    // Not set up in this browser: a file never says which saved key it uses
    expect(providers.anthropic).toMatchObject({ hasKey: false });
    expect(providers.anthropic).not.toHaveProperty('keyRef');
    expect(summary.unbound.providers.sort()).toEqual(['anthropic', 'custom1', 'openai']);

    expect(storage.map.get('firewall-settings')).toEqual({ enabled: true });
    expect(storage.map.get('gate-settings')).toEqual({ confirm: ['send', 'delete'] });
    expect(storage.map.get('skills')).toEqual({ skills: [] });
    expect(storage.map.get('general-settings')).toEqual({ assistantName: 'Eve' });

    const c1 = (await db.connectors.get('c1')) as ConnectorRecord;
    expect(c1).toMatchObject({
      url: 'https://evil.example/mcp',
      // Moved: off, in no workspace, and every tool asks, until the user confirms the new server
      status: 'disabled',
      workspaceIds: [],
      toolPolicy: {},
    });
    expect((await db.connectors.get('c2'))?.toolPolicy).toEqual({ send: 'approve' });
    expect(summary.unbound.connectors).toEqual(['c1']);
    // The sign-in this browser had for c1 is gone, c2's (same server) stays; the model key itself stays in the vault
    expect(vault.values.has('conn:c1:token')).toBe(false);
    expect(vault.values.get('conn:c2:token')).toBe('t2');
    expect(vault.values.get('llm:openai')).toBe('sk-mine');
    // Tool approvals are this browser's
    // c1 moved: the tools approved for its old server are not approved for the new one
    expect(await db.toolFingerprints.get('c1:send')).toBeUndefined();
  });

  it('a Nex Brain snapshot (the user’s own) still restores in full', async () => {
    const snapshot = await crafted();
    const { db, storage, vault } = await here();
    await restoreSnapshot(snapshot, target(db, storage, vault), null);
    expect(storage.map.get('firewall-settings')).toEqual({ enabled: false });
    expect((storage.map.get('llm-api-keys') as { providers: Record<string, unknown> }).providers.openai).toMatchObject({
      keyRef: 'llm:openai',
    });
    expect((await db.toolFingerprints.get('c1:send'))?.hash).toBe('evil');
  });
});

describe('scheduled work after a restore', () => {
  it('comes back from what the features store: routines, agent schedules and snoozes', async () => {
    const source = freshDb();
    const sourceJobs = new JobRunner(source);
    const workflows = new WorkflowService(source, sourceJobs, () => undefined);
    const draft = await workflows.saveDraft({ spec: morningTechNews('Europe/Lisbon'), request: 'news' });
    const routine = await workflows.confirm(draft.id);
    const agent = agentRecord({ triggers: [{ type: 'schedule', cron: '0 9 * * *', timezone: 'UTC' }] });
    await source.agents.add(agent);
    const snoozedUntil = Date.now() + 3600_000;
    await source.inbox.put({
      id: 'i1',
      source: 'test',
      externalId: 'x',
      kind: 'message',
      title: 'Later',
      status: 'snoozed',
      snoozeUntil: snoozedUntil,
      createdAt: 1,
      updatedAt: 1,
    } as never);
    expect(await source.jobs.count()).toBeGreaterThan(0);

    const db = freshDb();
    await restoreSnapshot(await snapshotOf(source), target(db));
    expect(await db.jobs.count()).toBe(0);

    // What each feature's registerRecovery does when the extension starts again
    const jobs = new JobRunner(db);
    await new WorkflowService(db, jobs, () => undefined).recover();
    await new AgentService({
      db,
      jobs,
      threads: () => ({}) as never,
      window: {} as never,
      maxConcurrent: async () => 1,
      siteAllowed: async () => true,
      roleModel: async () => ({ provider: 'mock', modelName: 'scripted' }),
      inbox: async () => {},
      settleInbox: async () => {},
      sleep: async () => {},
      now: () => Date.now(),
    } as unknown as AgentServiceDeps).recover();
    await rescheduleSnoozes(request => jobs.schedule(request), snoozeJobKey, db);

    expect(await db.jobs.where('key').equals(`workflow:${routine.id}`).first()).toMatchObject({
      cron: '30 7 * * *',
      status: 'scheduled',
    });
    expect(await db.jobs.where('key').equals(scheduleJobKey(agent.id, 0)).first()).toMatchObject({
      kind: 'agent-schedule',
      cron: '0 9 * * *',
    });
    expect(await db.jobs.where('key').equals(snoozeJobKey('i1')).first()).toMatchObject({
      kind: 'inbox_unsnooze',
      runAt: snoozedUntil,
    });
  });
});

describe('a file never chooses keys or permissions', () => {
  it("keeps this browser's key binding when the endpoint matches, whatever key the file names", async () => {
    const { unbindMovedProviders } = await import('../trust');
    const here = {
      providers: { openai: { type: 'openai', baseUrl: '', apiKey: '', keyRef: 'llm:openai', hasKey: true } },
    };
    const file = {
      providers: { openai: { type: 'openai', baseUrl: '', apiKey: '', keyRef: 'conn:github:token', hasKey: true } },
    };
    const { value } = unbindMovedProviders(file, here);
    expect((value as typeof file).providers.openai).toMatchObject({ keyRef: 'llm:openai', hasKey: true });
  });

  it("keeps this browser's sign-in, scope and tool rules for a connector on the same server", async () => {
    const { unbindMovedConnectors } = await import('../trust');
    const existing = {
      id: 'c1',
      kind: 'remote',
      url: 'https://mcp.example/mcp',
      name: 'Mine',
      authKind: 'token',
      secretRef: 'conn:c1:token',
      workspaceIds: ['work'],
      toolPolicy: { send: 'approve' },
      status: 'connected',
    };
    const file = { ...existing, name: 'Renamed', workspaceIds: ['work', 'personal'], toolPolicy: { send: 'allow' } };
    const { rows, unbound } = unbindMovedConnectors([file], [existing as never]);
    expect(unbound).toEqual([]);
    expect(rows[0]).toMatchObject({ name: 'Renamed', workspaceIds: ['work'], toolPolicy: { send: 'approve' } });
  });

  it('starts a new or moved connector disabled, in no workspace, with every tool asking', async () => {
    const { unbindMovedConnectors } = await import('../trust');
    const file = {
      id: 'new1',
      kind: 'remote',
      url: 'https://evil.example/mcp',
      authKind: 'none',
      secretRef: null,
      workspaceIds: ['work'],
      toolPolicy: { send: 'allow' },
      status: 'connected',
    };
    const { rows, unbound } = unbindMovedConnectors([file], []);
    expect(unbound).toEqual(['new1']);
    expect(rows[0]).toMatchObject({ status: 'disabled', workspaceIds: [], toolPolicy: {} });
  });
});
