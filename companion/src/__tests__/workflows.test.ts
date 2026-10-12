import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { workflowSyncReplySchema } from '@protocol';
import type { WorkflowPutRequest } from '@protocol';
import { memoryLogger } from '../log';
import { SandboxManager } from '../sandbox/manager';
import { createKeyStore } from '../workflows/keys';
import { CATCH_UP_MS, MacWorkflows } from '../workflows/service';
import { dockerUp, fakeRunner, memoryKeys, startTestBrain, tempDir } from './helpers';

const dirs: { remove: () => void }[] = [];
afterEach(() => dirs.splice(0).forEach(dir => dir.remove()));

function setup(
  options: { fetch?: typeof fetch; lookup?: (host: string) => Promise<{ address: string }[]>; now?: () => number } = {},
) {
  const dir = tempDir();
  dirs.push(dir);
  const log = memoryLogger();
  const run = fakeRunner(dockerUp);
  const sandbox = new SandboxManager({ run, image: 'img', dataDir: dir.path, log });
  const keys = memoryKeys();
  const clock = {
    now: options.now ?? Date.now,
    every: () => () => {},
    sleep: async () => {},
  };
  const workflows = new MacWorkflows({
    dataDir: dir.path,
    sandbox,
    keys,
    log,
    clock,
    fetch: options.fetch,
    lookup: options.lookup,
  });
  return { dir: dir.path, workflows, run, keys };
}

const sandboxRoutine = (status: 'active' | 'paused' = 'active'): WorkflowPutRequest => ({
  requestId: 'req-put-1',
  keepKey: false,
  workflow: {
    id: 'wf1',
    name: 'Build check',
    version: 1,
    workspaceId: null,
    agentId: null,
    status,
    spec: {
      name: 'Build check',
      nodes: [
        { id: 'start', type: 'trigger.manual', label: 'By hand' },
        { id: 'build', type: 'step.sandbox', label: 'Build', command: 'pnpm build' },
        { id: 'tell', type: 'out.inbox', label: 'Tell me', title: 'Build', body: '{{steps.build.output.stdout}}' },
      ],
      edges: [
        { from: 'start', to: 'build' },
        { from: 'build', to: 'tell' },
      ],
    },
  },
});

describe('MacWorkflows', () => {
  it('runs a routine with a sandbox step only after the click, and hands the result to the extension', async () => {
    const { workflows, run } = setup();
    await workflows.start();
    await workflows.put(sandboxRoutine());
    const runId = await workflows.runNow('wf1');
    await workflows.idle();

    // Running code waits for the user: an approval goes to the outbox, nothing ran yet
    let sync = workflows.sync(0);
    expect(sync.outbox.map(item => item.kind)).toEqual(['approval']);
    expect(sync.outbox[0]).toMatchObject({ runId, nodeId: 'build', detail: 'pnpm build' });
    expect(sync.runs[0].run).toMatchObject({ id: runId, status: 'waiting_user' });
    expect(run.calls.some(call => call.args[0] === 'run')).toBe(false);

    await workflows.answer(runId, 'build', true);
    await workflows.idle();
    sync = workflows.sync(sync.cursor);
    expect(sync.runs[0].run).toMatchObject({ status: 'succeeded' });
    const steps = sync.runs[0].steps as { nodeId: string; status: string; output: unknown }[];
    expect(steps.find(step => step.nodeId === 'build')).toMatchObject({
      status: 'succeeded',
      output: { exitCode: 0, stdout: 'ran: pnpm build\n' },
    });
    const inbox = sync.outbox.find(item => item.kind === 'inbox');
    expect(inbox).toMatchObject({ title: 'Build', body: 'ran: pnpm build\n' });
    workflowSyncReplySchema.parse(sync);

    await workflows.ack(sync.outbox.map(item => item.id));
    expect(workflows.sync(sync.cursor).outbox).toEqual([]);
    workflows.stop();
  });

  it('refuses steps that need the browser, and a thinking step without a model', async () => {
    const { workflows } = setup();
    await workflows.start();
    const browse = sandboxRoutine();
    (browse.workflow.spec as { nodes: unknown[] }).nodes[1] = {
      id: 'build',
      type: 'step.browse',
      label: 'Look',
      task: 'Read the news',
    };
    await expect(workflows.put(browse)).rejects.toThrow(/need the browser/);
    const thinking = sandboxRoutine();
    (thinking.workflow.spec as { nodes: unknown[] }).nodes[1] = {
      id: 'build',
      type: 'step.llm',
      label: 'Think',
      instructions: 'Sum up',
    };
    await expect(workflows.put(thinking)).rejects.toThrow(/send the model/);
    workflows.stop();
  });

  it('keeps a model key out of its files', async () => {
    const { workflows, dir, keys } = setup();
    await workflows.start();
    const thinking = sandboxRoutine();
    (thinking.workflow.spec as { nodes: unknown[] }).nodes[1] = {
      id: 'build',
      type: 'step.llm',
      label: 'Think',
      instructions: 'Sum up',
    };
    await workflows.put({
      ...thinking,
      model: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'x/y',
        apiKey: 'sk-or-very-secret-1234567890',
        contextWindow: 32768,
      },
    });
    expect(keys.values.get('workflow:wf1')).toBe('sk-or-very-secret-1234567890');
    expect(readFileSync(join(dir, 'workflows', 'state.json'), 'utf8')).not.toContain('sk-or-very-secret');
    await workflows.remove('wf1');
    expect(keys.values.has('workflow:wf1')).toBe(false);
    workflows.stop();
  });

  it('fetches only public addresses: a name that resolves to the home network is refused', async () => {
    let fetched = 0;
    const { workflows } = setup({
      fetch: (async () => {
        fetched++;
        return new Response(JSON.stringify({ hits: [{ title: 'A' }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
      lookup: async host => [{ address: host === 'rebind.example.com' ? '192.168.1.10' : '93.184.216.34' }],
    });
    await workflows.start();
    const routine = (url: string): WorkflowPutRequest => ({
      requestId: 'req-x',
      keepKey: false,
      workflow: {
        id: 'news',
        name: 'News',
        version: 1,
        workspaceId: null,
        agentId: null,
        status: 'active',
        spec: {
          name: 'News',
          nodes: [
            { id: 'start', type: 'trigger.manual', label: 'By hand' },
            { id: 'get', type: 'step.http_get', label: 'Get', url },
          ],
          edges: [{ from: 'start', to: 'get' }],
          allowHosts: ['hn.algolia.com', 'rebind.example.com'],
        },
      },
    });
    await workflows.put(routine('https://hn.algolia.com/api/v1/search'));
    const good = await workflows.runNow('news');
    await workflows.idle();
    await workflows.put(routine('https://rebind.example.com/api'));
    const bad = await workflows.runNow('news');
    await workflows.idle();
    const runs = Object.fromEntries(workflows.sync(0).runs.map(entry => [entry.run.id, entry]));
    expect(runs[good].run).toMatchObject({ status: 'succeeded' });
    expect(runs[bad].run).toMatchObject({ status: 'failed' });
    expect(String((runs[bad].run.error as { message: string }).message)).toMatch(/private or local/);
    expect(fetched).toBe(1);
    workflows.stop();
  });

  it('fires a due schedule once, and skips a time missed by more than the catch-up window', async () => {
    let now = Date.parse('2026-10-12T07:00:00Z');
    const { workflows } = setup({ now: () => now });
    await workflows.start();
    const scheduled = sandboxRoutine();
    const spec = scheduled.workflow.spec as { nodes: Record<string, unknown>[] };
    spec.nodes[0] = { id: 'start', type: 'trigger.schedule', label: 'Daily', cron: '30 7 * * *', timezone: 'UTC' };
    spec.nodes[1] = { id: 'build', type: 'out.inbox', label: 'Note', title: 'Morning' };
    spec.nodes.splice(2, 1);
    (scheduled.workflow.spec as { edges: unknown[] }).edges = [{ from: 'start', to: 'build' }];
    const stored = await workflows.put(scheduled);
    expect(stored.nextRunAt).toBe(Date.parse('2026-10-12T07:30:00Z'));

    now = Date.parse('2026-10-12T07:30:10Z');
    await workflows.tick();
    await workflows.tick();
    await workflows.idle();
    expect(workflows.sync(0).runs).toHaveLength(1);

    // The Mac slept through the next morning's time
    now = Date.parse('2026-10-13T07:30:00Z') + CATCH_UP_MS + 60_000;
    await workflows.tick();
    await workflows.idle();
    expect(workflows.sync(0).runs).toHaveLength(1);
    expect(workflows.store.macWorkflow('wf1')?.nextRunAt).toBe(Date.parse('2026-10-14T07:30:00Z'));
    workflows.stop();
  });

  it('serves routines over the protocol', async () => {
    const test = await startTestBrain();
    try {
      await test.pair();
      const put = await test.api('/v1/workflows/wf1', { method: 'PUT', body: JSON.stringify(sandboxRoutine()) });
      expect(put.status).toBe(200);
      const run = await test.api('/v1/workflows/wf1/run', {
        method: 'POST',
        body: JSON.stringify({ requestId: 'req-run-1' }),
      });
      const { runId } = (await run.json()) as { runId: string };
      await test.brain.workflows.idle();
      const sync = workflowSyncReplySchema.parse(
        await (await test.api('/v1/workflows/sync', { body: JSON.stringify({ cursor: 0 }) })).json(),
      );
      expect(sync.runs.map(entry => entry.run.id)).toEqual([runId]);
      const answer = await test.api('/v1/workflows/runs/answer', {
        method: 'POST',
        body: JSON.stringify({ requestId: 'req-answer-1', runId, nodeId: 'build', approved: false }),
      });
      expect(answer.status).toBe(200);
      await test.brain.workflows.idle();
      const after = workflowSyncReplySchema.parse(
        await (await test.api('/v1/workflows/sync', { body: JSON.stringify({ cursor: sync.cursor }) })).json(),
      );
      expect(after.runs[0].run).toMatchObject({ status: 'cancelled' });
      expect(
        (await test.api('/v1/workflows/other', { method: 'PUT', body: JSON.stringify(sandboxRoutine()) })).status,
      ).toBe(400);
    } finally {
      await test.stop();
    }
  });
});

describe('keys', () => {
  it('passes a kept key to the Keychain on standard input, never as an argument', async () => {
    const run = fakeRunner(call =>
      call.args.includes('find-generic-password') ? { stdout: 'sk-kept-1234567890\n' } : {},
    );
    const keys = createKeyStore({ run, isMac: true });
    await keys.set('workflow:wf1', 'sk-kept-1234567890', true);
    const add = run.calls[0];
    expect(add.command).toBe('/usr/bin/security');
    expect(add.args).toEqual(['-i']);
    expect(add.options.stdin).toContain('sk-kept-1234567890');
    expect(run.calls.every(call => !call.args.join(' ').includes('sk-kept'))).toBe(true);
    await expect(keys.set('workflow:wf1', 'has "quotes"', true)).rejects.toMatchObject({ kind: 'invalid' });
    // A fresh store (after a restart) finds it in the Keychain
    expect(await createKeyStore({ run, isMac: true }).get('workflow:wf1')).toBe('sk-kept-1234567890');
  });
});
