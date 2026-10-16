import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AviCopilotDb } from '@extension/storage';
import type { RunRecord, RunStep, WorkflowRecord } from '@extension/storage';
import { AppError } from '@extension/shared';
import { WorkflowEngine } from '../engine';
import type { EngineClock, EngineHooks, StepExecutor } from '../engine';
import { createEngineStore, newWorkflowRecord } from '../store';
import type { WorkflowEdge, WorkflowNode, WorkflowSpec } from '../spec';
import { DEFAULT_BUDGET } from '../spec';

let db: AviCopilotDb;
let now: number;
let slept: number[];
let events: string[];
let executors: Record<string, StepExecutor>;
let overBudget: string | null;

const clock: EngineClock = {
  now: () => now,
  every: () => () => {},
  sleep: async ms => {
    slept.push(ms);
  },
};

const hooks: EngineHooks = {
  approvalNeeded: async (_run, step) => void events.push(`approval:${step.nodeId}`),
  unknownOutcome: async (_run, step) => void events.push(`unknown:${step.nodeId}`),
  wakeAt: async (runId, at) => void events.push(`wake:${at - now}`),
  finished: async run => void events.push(`finished:${run.status}`),
  autoPaused: async workflow => void events.push(`paused:${workflow.name}`),
  overBudget: async () => overBudget,
};

function makeEngine() {
  return new WorkflowEngine(createEngineStore(db), type => executors[type], hooks, clock);
}

function spec(nodes: WorkflowNode[], edges: WorkflowEdge[], budget = {}): WorkflowSpec {
  return {
    v: 1,
    name: 'Test',
    description: '',
    nodes,
    edges,
    allowHosts: ['example.com'],
    budget: { ...DEFAULT_BUDGET, ...budget },
  };
}

const manual: WorkflowNode = { id: 'start', type: 'trigger.manual', label: 'Start' };
const fetchNode: WorkflowNode = {
  id: 'fetch',
  type: 'step.http_get',
  label: 'Fetch',
  url: 'https://example.com/data',
  format: 'json',
  maxBytes: 10_000,
};
const summarise: WorkflowNode = {
  id: 'sum',
  type: 'step.llm',
  label: 'Summarise',
  instructions: 'Summarise it',
  input: 'Data: {{steps.fetch.output}}',
};
const inbox: WorkflowNode = {
  id: 'note',
  type: 'out.inbox',
  label: 'Note',
  title: 'Done',
  body: '{{steps.sum.output}}',
  priority: 'normal',
};
const linear = spec(
  [manual, fetchNode, summarise, inbox],
  [
    { from: 'start', to: 'fetch' },
    { from: 'fetch', to: 'sum' },
    { from: 'sum', to: 'note' },
  ],
);

async function saveWorkflow(workflowSpec: WorkflowSpec, fields: Partial<WorkflowRecord> = {}) {
  const workflow = newWorkflowRecord({
    name: workflowSpec.name,
    spec: workflowSpec,
    status: 'active',
    version: 1,
    ...fields,
  });
  await db.workflows.add(workflow);
  return workflow;
}

const stepsOf = async (runId: string): Promise<Record<string, RunStep>> =>
  Object.fromEntries((await db.runSteps.where('runId').equals(runId).toArray()).map(step => [step.nodeId, step]));

const done = (output: unknown, extra: Partial<{ tainted: boolean; usage: object }> = {}) => ({
  kind: 'done' as const,
  output,
  ...extra,
});

beforeEach(() => {
  db = new AviCopilotDb(`workflows-${crypto.randomUUID()}`);
  now = new Date(2026, 9, 12, 7, 30).getTime();
  slept = [];
  events = [];
  overBudget = null;
  executors = {
    'step.http_get': { retry: null, taints: true, execute: async () => done({ items: [1, 2, 3] }) },
    'step.llm': {
      retry: null,
      taints: false,
      usesModel: true,
      execute: async ({ params }) =>
        done(`summary of ${String(params.input)}`, { usage: { inputTokens: 100, outputTokens: 20, modelCalls: 1 } }),
    },
    'out.inbox': { retry: null, taints: false, execute: async ({ params }) => done({ posted: params.body }) },
  };
});

describe('WorkflowEngine', () => {
  it('runs every step in order, passes outputs on through places, and counts usage and taint', async () => {
    const engine = makeEngine();
    const workflow = await saveWorkflow(linear);
    const run = await engine.createRun(workflow, { trigger: { type: 'manual', detail: '' }, attended: true });
    expect(Object.values(await stepsOf(run.id)).map(step => step.status)).toEqual([
      'queued',
      'queued',
      'queued',
      'queued',
    ]);

    const ended = await engine.execute(run.id, new AbortController().signal);
    expect(ended?.status).toBe('succeeded');
    const steps = await stepsOf(run.id);
    expect(steps.start.status).toBe('succeeded');
    expect(steps.sum.output).toBe('summary of Data: {"items":[1,2,3]}');
    expect(steps.note.output).toEqual({ posted: 'summary of Data: {"items":[1,2,3]}' });
    const stored = (await db.runs.get(run.id))!;
    expect(stored).toMatchObject({
      tainted: true,
      inputTokens: 100,
      outputTokens: 20,
      modelCalls: 1,
      leaseUntil: null,
    });
    expect((await db.workflows.get(workflow.id))!).toMatchObject({ lastRunStatus: 'succeeded', failuresInRow: 0 });
    expect(events).toEqual(['finished:succeeded']);
  });

  it('retries a step that is safe to repeat, and tries others once', async () => {
    let calls = 0;
    executors['step.http_get'] = {
      retry: { attempts: 3, baseMs: 100, capMs: 1000 },
      taints: true,
      async execute() {
        calls += 1;
        if (calls < 3) throw new AppError('unavailable', 'Down for a moment');
        return done({ ok: true });
      },
    };
    const engine = makeEngine();
    const workflow = await saveWorkflow(linear);
    const run = await engine.createRun(workflow, { trigger: { type: 'manual', detail: '' }, attended: true });
    expect((await engine.execute(run.id, new AbortController().signal))?.status).toBe('succeeded');
    expect((await stepsOf(run.id)).fetch.attempts).toBe(3);
    expect(slept).toHaveLength(2);

    // A model step is not wrapped again: one failure ends the run
    executors['step.llm'] = {
      retry: null,
      taints: false,
      usesModel: true,
      execute: async () => {
        throw new AppError('network', 'Could not reach the service.');
      },
    };
    const second = await engine.createRun(workflow, { trigger: { type: 'manual', detail: '' }, attended: true });
    const failed = await engine.execute(second.id, new AbortController().signal);
    expect(failed?.status).toBe('failed');
    expect(failed?.error?.message).toContain('Summarise');
    expect((await stepsOf(second.id)).sum).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('waits for the user before a side effect, asks in the Inbox, and never retries it', async () => {
    const post: WorkflowNode = {
      id: 'post',
      type: 'step.tool',
      label: 'Post the summary',
      connector: 'slack',
      tool: 'post_message',
      args: '',
      readOnly: false,
    };
    let posted = 0;
    // Stands in for a write tool's executor: retry is offered, and must never be used for a side effect
    executors['step.tool'] = {
      retry: { attempts: 3, baseMs: 10, capMs: 10 },
      taints: false,
      async execute() {
        posted += 1;
        return done('posted');
      },
    };
    const engine = makeEngine();
    const workflow = await saveWorkflow(spec([manual, post], [{ from: 'start', to: 'post' }]));
    const run = await engine.createRun(workflow, { trigger: { type: 'schedule', detail: '' }, attended: false });
    const waiting = await engine.execute(run.id, new AbortController().signal);
    expect(waiting?.status).toBe('waiting_user');
    expect((await stepsOf(run.id)).post).toMatchObject({
      status: 'waiting_user',
      approval: 'pending',
      sideEffect: true,
    });
    expect(events).toEqual(['approval:post']);
    expect(posted).toBe(0);

    expect(await engine.answer(run.id, 'post', true)).not.toBeNull();
    expect((await engine.execute(run.id, new AbortController().signal))?.status).toBe('succeeded');
    expect(posted).toBe(1);

    // Declined: the run ends and the step never runs
    const declined = await engine.createRun(workflow, { trigger: { type: 'schedule', detail: '' }, attended: false });
    await engine.execute(declined.id, new AbortController().signal);
    await engine.answer(declined.id, 'post', false);
    expect((await engine.execute(declined.id, new AbortController().signal))?.status).toBe('cancelled');
    expect(posted).toBe(1);

    // Cut off by a network error: not retried, and its outcome is unknown
    executors['step.tool'] = {
      retry: { attempts: 3, baseMs: 10, capMs: 10 },
      taints: false,
      async execute() {
        posted += 1;
        throw new AppError('network', 'Connection lost');
      },
    };
    const cut = await engine.createRun(workflow, { trigger: { type: 'schedule', detail: '' }, attended: false });
    await engine.execute(cut.id, new AbortController().signal);
    await engine.answer(cut.id, 'post', true);
    expect((await engine.execute(cut.id, new AbortController().signal))?.status).toBe('unknown_outcome');
    expect(posted).toBe(2);
    expect(slept).toEqual([]);
    expect(events).toContain('unknown:post');
  });

  it('stops a step that is not built yet with a plain message', async () => {
    const engine = makeEngine();
    const workflow = await saveWorkflow(
      spec([manual, { id: 'say', type: 'out.speak', label: 'Say it', text: 'hello' }], [{ from: 'start', to: 'say' }]),
    );
    const run = await engine.createRun(workflow, { trigger: { type: 'manual', detail: '' }, attended: true });
    const ended = await engine.execute(run.id, new AbortController().signal);
    expect(ended?.status).toBe('failed');
    expect(ended?.error?.kind).toBe('unavailable');
  });

  it('takes the branch a condition chose and skips the other', async () => {
    const check: WorkflowNode = {
      id: 'check',
      type: 'step.condition',
      label: 'Anything new?',
      left: '{{steps.fetch.output}}',
      op: 'contains',
      right: 'items',
    };
    const yes: WorkflowNode = {
      id: 'yes',
      type: 'out.inbox',
      label: 'Yes',
      title: 'New',
      body: '',
      priority: 'normal',
    };
    const no: WorkflowNode = {
      id: 'no',
      type: 'out.inbox',
      label: 'No',
      title: 'Nothing',
      body: '',
      priority: 'normal',
    };
    const engine = makeEngine();
    const workflow = await saveWorkflow(
      spec(
        [manual, fetchNode, check, yes, no],
        [
          { from: 'start', to: 'fetch' },
          { from: 'fetch', to: 'check' },
          { from: 'check', to: 'yes', when: 'true' },
          { from: 'check', to: 'no', when: 'false' },
        ],
      ),
    );
    const run = await engine.createRun(workflow, { trigger: { type: 'manual', detail: '' }, attended: true });
    expect((await engine.execute(run.id, new AbortController().signal))?.status).toBe('succeeded');
    const steps = await stepsOf(run.id);
    expect(steps.check.output).toEqual({ value: true });
    expect(steps.yes.status).toBe('succeeded');
    expect(steps.no.status).toBe('skipped');
  });

  it('stops when cancelled, mid-step or while it waits', async () => {
    executors['step.http_get'] = {
      retry: null,
      taints: true,
      execute: ({ signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new AppError('cancelled', 'Stopped.')), { once: true }),
        ),
    };
    const engine = makeEngine();
    const workflow = await saveWorkflow(linear);
    const run = await engine.createRun(workflow, { trigger: { type: 'manual', detail: '' }, attended: true });
    const controller = new AbortController();
    const running = engine.execute(run.id, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await stepsOf(run.id)).fetch.status).toBe('running');
    controller.abort();
    expect((await running)?.status).toBe('cancelled');
    expect((await stepsOf(run.id)).fetch.status).toBe('cancelled');
    expect((await stepsOf(run.id)).sum.status).toBe('queued');

    const queued = await engine.createRun(workflow, { trigger: { type: 'manual', detail: '' }, attended: true });
    expect((await engine.cancel(queued.id))?.status).toBe('cancelled');
  });

  it('parks a step that waits, wakes it later, and does not count the wake as an attempt', async () => {
    let checks = 0;
    executors['step.http_get'] = {
      retry: null,
      taints: true,
      resumable: true,
      async execute({ state, saveState }) {
        checks += 1;
        if (!state) {
          await saveState({ started: true });
          return { kind: 'park', until: now + 60_000, waitingUser: true };
        }
        return done('finished');
      },
    };
    const engine = makeEngine();
    const workflow = await saveWorkflow(linear);
    const run = await engine.createRun(workflow, { trigger: { type: 'manual', detail: '' }, attended: true });
    expect((await engine.execute(run.id, new AbortController().signal))?.status).toBe('waiting_user');
    expect(events).toEqual(['wake:60000']);
    expect((await stepsOf(run.id)).fetch).toMatchObject({
      status: 'waiting_user',
      attempts: 1,
      state: { started: true },
    });

    now += 60_000;
    expect((await engine.execute(run.id, new AbortController().signal))?.status).toBe('succeeded');
    expect(checks).toBe(2);
    expect((await stepsOf(run.id)).fetch).toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it('picks up after a restart: repeats safe steps, marks a cut-off side effect unknown, and closes old runs', async () => {
    let hang = true;
    executors['step.http_get'] = {
      retry: null,
      taints: true,
      execute: () => (hang ? new Promise(() => {}) : Promise.resolve(done({ items: [] }))),
    };
    const workflow = await saveWorkflow(linear);
    const first = makeEngine();
    const run = await first.createRun(workflow, { trigger: { type: 'manual', detail: '' }, attended: true });
    void first.execute(run.id, new AbortController().signal);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await db.runs.get(run.id))?.status).toBe('running');

    // The background stops; a new one starts over the same database
    hang = false;
    now += 30_000;
    const second = makeEngine();
    const recovered = await second.recover();
    expect(recovered.resume).toEqual([run.id]);
    expect((await stepsOf(run.id)).fetch.status).toBe('queued');
    expect((await second.execute(run.id, new AbortController().signal))?.status).toBe('succeeded');

    // A side effect that was running when it stopped is never run again
    const sideEffectRun = await second.createRun(workflow, { trigger: { type: 'manual', detail: '' }, attended: true });
    await db.runs.update(sideEffectRun.id, { status: 'running', leaseUntil: now });
    const step = (await stepsOf(sideEffectRun.id)).note;
    await db.runSteps.update(step.id, { status: 'running', sideEffect: true });
    // An old run cut off long ago
    const old = await second.createRun(workflow, { trigger: { type: 'manual', detail: '' }, attended: true });
    await db.runs.update(old.id, { status: 'running', leaseUntil: now - 60 * 60_000 });
    await db.runSteps.update((await stepsOf(old.id)).fetch.id, { status: 'running' });

    events = [];
    const again = await makeEngine().recover();
    expect(again.resume).toEqual([]);
    expect((await db.runs.get(sideEffectRun.id))?.status).toBe('unknown_outcome');
    expect((await stepsOf(sideEffectRun.id)).note.status).toBe('unknown_outcome');
    expect(events).toContain('unknown:note');
    expect((await db.runs.get(old.id))?.status).toBe('interrupted');
    expect((await stepsOf(old.id)).fetch.status).toBe('interrupted');
  });

  it('pauses a workflow after three failed runs in a row', async () => {
    executors['step.http_get'] = {
      retry: null,
      taints: true,
      execute: async () => {
        throw new AppError('not_found', 'Gone');
      },
    };
    const engine = makeEngine();
    const workflow = await saveWorkflow(linear);
    for (let index = 0; index < 3; index++) {
      const run = await engine.createRun(workflow, { trigger: { type: 'schedule', detail: '' }, attended: false });
      expect((await engine.execute(run.id, new AbortController().signal))?.status).toBe('failed');
    }
    expect(await db.workflows.get(workflow.id)).toMatchObject({ status: 'paused', failuresInRow: 3 });
    expect(events.filter(event => event.startsWith('paused'))).toEqual(['paused:Test']);
  });

  it('keeps to the budget: model calls per run and the daily cap', async () => {
    const engine = makeEngine();
    const tight = await saveWorkflow({ ...linear, budget: { ...linear.budget, maxModelCalls: 0 } });
    const run = await engine.createRun(tight, { trigger: { type: 'manual', detail: '' }, attended: true });
    const ended = await engine.execute(run.id, new AbortController().signal);
    expect(ended?.status).toBe('failed');
    expect(ended?.error?.kind).toBe('budget');

    overBudget = "Today's spending cap is reached.";
    const capped = await saveWorkflow(linear);
    const second = await engine.createRun(capped, { trigger: { type: 'manual', detail: '' }, attended: true });
    const stopped = await engine.execute(second.id, new AbortController().signal);
    expect(stopped?.error).toEqual({ kind: 'budget', message: "Today's spending cap is reached." });
    expect((await stepsOf(second.id)).fetch.status).toBe('succeeded');
  });

  it('refuses to make a run of a workflow that is not valid', async () => {
    const engine = makeEngine();
    const broken = await saveWorkflow({ ...linear, edges: [] });
    await expect(engine.createRun(broken, { trigger: { type: 'manual', detail: '' }, attended: true })).rejects.toThrow(
      /not valid/,
    );
    const runs: RunRecord[] = await db.runs.toArray();
    expect(runs).toHaveLength(0);
  });

  it('fails a side effect that cannot run before asking the user to allow it, and asks when it can', async () => {
    const sandbox: WorkflowNode = { id: 'code', type: 'step.sandbox', label: 'Run the script', command: 'echo hi' };
    let ran = 0;
    let paired = false;
    executors['step.sandbox'] = {
      retry: null,
      taints: true,
      check: async () => {
        if (!paired) throw new AppError('unavailable', 'This step needs Nex Brain.');
      },
      execute: async () => {
        ran += 1;
        return done('hi');
      },
    };
    const engine = makeEngine();
    const workflow = await saveWorkflow(spec([manual, sandbox], [{ from: 'start', to: 'code' }]));
    const run = await engine.createRun(workflow, { trigger: { type: 'manual', detail: '' }, attended: true });
    const failed = await engine.execute(run.id, new AbortController().signal);
    expect(failed).toMatchObject({
      status: 'failed',
      error: { message: 'Run the script: This step needs Nex Brain.' },
    });
    expect((await stepsOf(run.id)).code).toMatchObject({ status: 'failed', approval: null, attempts: 0 });
    expect(events).not.toContain('approval:code');

    paired = true;
    const next = await engine.createRun(workflow, { trigger: { type: 'manual', detail: '' }, attended: true });
    expect((await engine.execute(next.id, new AbortController().signal))?.status).toBe('waiting_user');
    expect(events).toContain('approval:code');
    // Once allowed it is not checked again: the click is the user's answer
    paired = false;
    await engine.answer(next.id, 'code', true);
    expect((await engine.execute(next.id, new AbortController().signal))?.status).toBe('succeeded');
    expect(ran).toBe(1);
  });

  it('after a restart, a side effect that handed its work on carries on instead of being marked unknown', async () => {
    const agentStep: WorkflowNode = {
      id: 'agent',
      type: 'step.agent',
      label: 'Ask the agent',
      task: 'Check',
      agent: 'A',
    };
    let polls = 0;
    executors['step.agent'] = {
      retry: null,
      taints: true,
      resumable: true,
      async execute({ state, saveState }) {
        polls += 1;
        if (!state) {
          await saveState({ agentRunId: 'r1' });
          return { kind: 'park', until: now + 15_000, waitingUser: false };
        }
        return done('the agent answered');
      },
    };
    const workflow = await saveWorkflow(spec([manual, agentStep], [{ from: 'start', to: 'agent' }]));
    const engine = makeEngine();
    const run = await engine.createRun(workflow, { trigger: { type: 'manual', detail: '' }, attended: true });
    expect((await engine.execute(run.id, new AbortController().signal))?.status).toBe('waiting_user');
    await engine.answer(run.id, 'agent', true);
    expect((await engine.execute(run.id, new AbortController().signal))?.status).toBe('running');

    // The background stops long after the run began (the agent's work goes on without it)
    now += 60 * 60_000;
    events = [];
    const recovered = await makeEngine().recover();
    expect(recovered.resume).toEqual([run.id]);
    expect(events).not.toContain('unknown:agent');
    expect((await makeEngine().execute(run.id, new AbortController().signal))?.status).toBe('succeeded');
    expect(polls).toBe(2);
  });
});
