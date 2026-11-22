import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('webextension-polyfill', () => ({ default: {} }));

const { AviCopilotDb, permissionRulesStore } = await import('@extension/storage');
const { JobRunner } = await import('../../jobs/runner');
const { setServices } = await import('../../registry/services');
const { WorkflowService } = await import('../service');
const { DEFAULT_BUDGET } = await import('../spec');
import type { Services } from '../../registry/services';
import type { StepExecutor } from '../engine';
import type { WorkflowNode, WorkflowSpec } from '../spec';

/** "Allow every time" for a routine's step in the Inbox (issue #93). */

let db: InstanceType<typeof AviCopilotDb>;
let service: InstanceType<typeof WorkflowService>;
let executors: Record<string, StepExecutor>;
let started: number;

const agentNode: WorkflowNode = { id: 'agent', type: 'step.agent', label: 'Ask the agent', task: 'Check', agent: 'A' };
const sandboxNode: WorkflowNode = { id: 'agent', type: 'step.sandbox', label: 'Run it', command: 'make' };

function specWith(node: WorkflowNode): WorkflowSpec {
  return {
    v: 1,
    name: 'Nightly check',
    description: '',
    nodes: [{ id: 'start', type: 'trigger.manual', label: 'Start' }, node],
    edges: [{ from: 'start', to: node.id }],
    allowHosts: [],
    budget: { ...DEFAULT_BUDGET },
  };
}

const until = async (check: () => Promise<boolean>) => {
  for (let index = 0; index < 100; index++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('It never happened');
};

async function workflowOf(node: WorkflowNode) {
  return service.confirm((await service.saveDraft({ spec: specWith(node), request: 'x' })).id);
}

async function startRun(workflowId: string) {
  const run = await service.start(workflowId, { trigger: { type: 'manual', detail: '' }, attended: true });
  await until(async () => ['waiting_user', 'succeeded'].includes((await db.runs.get(run.id))!.status));
  return (await db.runs.get(run.id))!;
}

const approvalOf = async () => (await db.inbox.toArray()).filter(item => item.kind === 'approval').at(-1)!;

beforeEach(async () => {
  db = new AviCopilotDb(`allow-rule-${crypto.randomUUID()}`);
  started = 0;
  const execute: StepExecutor['execute'] = async () => {
    started += 1;
    return { kind: 'done', output: 'ok' };
  };
  executors = {
    'step.agent': { retry: null, taints: false, execute },
    'step.sandbox': { retry: null, taints: false, execute },
  };
  service = new WorkflowService(db, new JobRunner(db), type => executors[type]);
  setServices({} as unknown as Services);
  for (const rule of await permissionRulesStore.list()) await permissionRulesStore.remove(rule.id);
});

describe('allow every time on a routine step', () => {
  it('offers it for a step that starts an agent, and after it the next run starts without a click', async () => {
    const workflow = await workflowOf(agentNode);
    const first = await startRun(workflow.id);
    expect(first.status).toBe('waiting_user');
    const item = await approvalOf();
    expect(item.approval).toMatchObject({ always: true });

    expect(await service.answerRequest(item.approval!.requestId, true, { always: true })).toBe(true);
    await until(async () => (await db.runs.get(first.id))!.status === 'succeeded');
    expect(await permissionRulesStore.list()).toHaveLength(1);
    expect(started).toBe(1);

    const second = await startRun(workflow.id);
    expect(second.status).toBe('succeeded');
    expect(started).toBe(2);
    expect((await permissionRulesStore.list())[0]!.uses).toBe(1);
  });

  it('Allow once saves nothing and the next run asks again', async () => {
    const workflow = await workflowOf(agentNode);
    const first = await startRun(workflow.id);
    await service.answerRequest((await approvalOf()).approval!.requestId, true);
    await until(async () => (await db.runs.get(first.id))!.status === 'succeeded');
    expect(await permissionRulesStore.list()).toHaveLength(0);
    expect((await startRun(workflow.id)).status).toBe('waiting_user');
  });

  it('asks again once the step has changed, because the rule names the step as it was', async () => {
    const workflow = await workflowOf(agentNode);
    const first = await startRun(workflow.id);
    await service.answerRequest((await approvalOf()).approval!.requestId, true, { always: true });
    await until(async () => (await db.runs.get(first.id))!.status === 'succeeded');

    const changed = { ...agentNode, task: 'Check something else entirely' } as WorkflowNode;
    const revised = await service.saveDraft({ spec: specWith(changed), request: 'y', workflowId: workflow.id });
    await service.confirm(revised.id);
    expect((await startRun(workflow.id)).status).toBe('waiting_user');
  });

  it('never offers it for a step that runs code, and ignores an Allow every time sent for one', async () => {
    const workflow = await workflowOf(sandboxNode);
    const run = await startRun(workflow.id);
    expect(run.status).toBe('waiting_user');
    const item = await approvalOf();
    expect(item.approval?.always).toBeUndefined();
    await service.answerRequest(item.approval!.requestId, true, { always: true });
    await until(async () => (await db.runs.get(run.id))!.status === 'succeeded');
    expect(await permissionRulesStore.list()).toHaveLength(0);
  });

  it('a declined card saves no rule even when Allow every time was sent', async () => {
    const workflow = await workflowOf(agentNode);
    await startRun(workflow.id);
    await service.answerRequest((await approvalOf()).approval!.requestId, false, { always: true });
    expect(await permissionRulesStore.list()).toHaveLength(0);
  });
});
