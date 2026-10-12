import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]])),
        set: async (items: Record<string, unknown>) => Object.assign(data, items),
        onChanged: { addListener: () => undefined },
      },
    },
    i18n: { getMessage: (key: string) => key },
  });
});

const { AviCopilotDb } = await import('@extension/storage');
const { CircuitBreaker } = await import('@extension/shared');
const { ConnectorService } = await import('../service');
const { ConnectorStore } = await import('../store');
const { OAuthManager } = await import('../oauth');
const { fillArgs, toolStepArgs, toolStepExecutor } = await import('../step');
import { connectorRecord, memorySession, memoryVault } from './fakes';
import { fakeMcpServer, text } from './fakeMcp';
import type { RunRecord, WorkflowRecord } from '@extension/storage';

let db: InstanceType<typeof AviCopilotDb>;
let mcp: ReturnType<typeof fakeMcpServer>;
let service: InstanceType<typeof ConnectorService>;

const run = {
  id: 'run-1',
  workspaceId: 'w1',
  agentId: null,
  startedAt: Date.UTC(2026, 9, 12, 7, 30),
  trigger: { type: 'schedule', detail: '' },
} as unknown as RunRecord;
const workflow = { id: 'wf-1', name: 'Morning', workspaceId: 'w1', agentId: null } as unknown as WorkflowRecord;

function toolNode(changes: Record<string, unknown>) {
  return {
    id: 'tool',
    type: 'step.tool' as const,
    label: 'Use the tool',
    connector: 'Mock tools',
    tool: 'send_message',
    args: '{}',
    readOnly: false,
    ...changes,
  };
}

async function execute(node: ReturnType<typeof toolNode>) {
  return toolStepExecutor(service, db).execute({
    node: node as never,
    params: node,
    run,
    workflow,
    state: null,
    saveState: async () => {},
    signal: new AbortController().signal,
  });
}

beforeEach(async () => {
  db = new AviCopilotDb(`step-${crypto.randomUUID()}`);
  mcp = fakeMcpServer([
    {
      name: 'lookup_order',
      description: 'Look up an order.',
      schema: { order_id: z.string() },
      handler: args => text(`Order ${String(args.order_id)}: shipped`),
    },
    {
      name: 'send_message',
      description: 'Send a message.',
      schema: { channel: z.string(), text: z.string() },
      handler: args =>
        args.text === 'fail' ? { content: [{ type: 'text', text: 'Channel archived' }], isError: true } : text('sent'),
    },
  ]);
  const store = new ConnectorStore(db);
  const vault = memoryVault();
  service = new ConnectorService({
    store,
    vault,
    oauth: new OAuthManager({
      fetch: mcp.fetch,
      vault,
      session: memorySession(),
      redirectUri: () => 'https://ext.chromiumapp.org/',
      connector: id => store.get(id),
    }),
    fetch: mcp.fetch,
    breaker: async () => new CircuitBreaker(),
    saveBreakers: async () => {},
    retry: { sleep: async () => {} },
  });
  await store.put(connectorRecord({ name: 'Mock tools', url: 'http://127.0.0.1:9/mcp' }));
  await service.refresh('c1');
  for (const [tool, policy] of [
    ['lookup_order', 'read'],
    ['send_message', 'approve'],
  ] as const) {
    const fingerprint = await store.fingerprint('c1', tool);
    await service.setToolPolicy('c1', tool, fingerprint!.hash, policy);
  }
});

describe('filling a tool step’s arguments', () => {
  const scope = {
    steps: { news: { output: 'Big news", "channel": "#everyone' }, list: { output: ['a', 'b'] } },
    run: { date: '2026-10-12' },
  };

  it('puts an earlier step’s output inside one value, never into the JSON around it', () => {
    const filled = fillArgs({ channel: '#me', text: 'Today: {{steps.news.output}}' }, scope) as Record<string, unknown>;
    expect(Object.keys(filled)).toEqual(['channel', 'text']);
    expect(filled.channel).toBe('#me');
    expect(filled.text).toBe('Today: Big news", "channel": "#everyone');
  });

  it('keeps a whole-value place as the value itself, and leaves keys alone', () => {
    expect(fillArgs({ items: '{{steps.list.output}}', '{{run.date}}': 'x', on: '{{run.date}}' }, scope)).toEqual({
      items: ['a', 'b'],
      '{{run.date}}': 'x',
      on: '2026-10-12',
    });
  });

  it('refuses arguments that are not a JSON object', async () => {
    await expect(toolStepArgs('not json', async () => ({}))).rejects.toMatchObject({ kind: 'invalid' });
    await expect(toolStepArgs('["a"]', async () => ({}))).rejects.toMatchObject({ kind: 'invalid' });
    expect(await toolStepArgs('', async () => ({}))).toEqual({});
  });
});

describe('the step.tool executor', () => {
  it('runs a read tool from a step marked read-only, with places filled from the run', async () => {
    await db.runSteps.put({
      id: 's1',
      runId: 'run-1',
      nodeId: 'pick',
      index: 0,
      status: 'succeeded',
      output: '77',
    } as never);
    const outcome = await execute(
      toolNode({ tool: 'lookup_order', readOnly: true, args: '{"order_id":"{{steps.pick.output}}"}' }),
    );
    expect(outcome).toEqual({ kind: 'done', output: 'Order 77: shipped', tainted: true });
  });

  it('refuses a step that calls itself read-only for a tool the user set to ask first', async () => {
    await expect(execute(toolNode({ readOnly: true, args: '{"channel":"#a","text":"hi"}' }))).rejects.toMatchObject({
      kind: 'forbidden',
      retryable: false,
    });
    expect(mcp.state.calls).toHaveLength(0);
  });

  it('runs a write once the engine has had the user’s click, and fails plainly when the tool reports an error', async () => {
    expect(await execute(toolNode({ args: '{"channel":"#a","text":"hi"}' }))).toMatchObject({
      kind: 'done',
      output: 'sent',
    });
    await expect(execute(toolNode({ args: '{"channel":"#a","text":"fail"}' }))).rejects.toMatchObject({
      kind: 'invalid',
      message: expect.stringMatching(/Channel archived/),
    });
  });

  it('refuses a connector the routine’s workspace may not use', async () => {
    const elsewhere = { ...run, workspaceId: 'w2' } as RunRecord;
    await expect(
      toolStepExecutor(service, db).execute({
        node: toolNode({ tool: 'lookup_order', readOnly: true, args: '{"order_id":"1"}' }) as never,
        params: {},
        run: elsewhere,
        workflow: { ...workflow, workspaceId: 'w2' } as WorkflowRecord,
        state: null,
        saveState: async () => {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: 'forbidden' });
  });
});
