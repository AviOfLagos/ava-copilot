import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AviCopilotDb } from '@extension/storage';
import type { RunRecord, RunStep, WorkflowRecord } from '@extension/storage';
import type { StepContext } from '../../workflows/engine';
import { agentStepExecutor, AGENT_STEP_POLL_MS } from '../workflow-step';

let db: AviCopilotDb;
let requests: Record<string, unknown>[];
let saved: unknown;

const workflow = { id: 'wf-1', name: 'Morning', workspaceId: 'ws-1' } as WorkflowRecord;
const workflowRun = { id: 'wrun-1', tainted: true } as RunRecord;

function context(state: unknown, agent = 'Scout'): StepContext {
  return {
    node: { id: 'ask', type: 'step.agent', label: 'Ask the scout', task: 'Find three papers', agent },
    params: { id: 'ask', type: 'step.agent', label: 'Ask the scout', task: 'Find three papers', agent },
    run: workflowRun,
    workflow,
    state,
    saveState: async value => void (saved = value),
    signal: new AbortController().signal,
  };
}

async function agentRun(status: RunRecord['status'], fields: Partial<RunRecord> = {}, started = true) {
  const run = {
    id: 'arun-1',
    kind: 'agent',
    workflowId: null,
    agentId: 'agent-1',
    workspaceId: 'ws-1',
    trigger: { type: 'workflow', detail: 'Morning' },
    status,
    tainted: true,
    startedAt: 1,
    endedAt: null,
    leaseUntil: null,
    inputTokens: 40,
    outputTokens: 4,
    costUsd: 0.01,
    error: null,
    ...fields,
  } as RunRecord;
  await db.runs.put(run);
  const task: RunStep = {
    id: 'arun-1-task',
    runId: run.id,
    nodeId: 'task',
    index: 1,
    status: status === 'succeeded' ? 'succeeded' : 'running',
    sideEffect: true,
    attempts: 1,
    startedAt: 1,
    endedAt: null,
    input: null,
    output: status === 'succeeded' ? 'Three papers: a, b, c' : null,
    error: null,
    state: started ? { threadId: 'thread-1', tabId: 1, windowId: 2, startUrl: 'https://example.com/' } : null,
  };
  await db.runSteps.put(task);
  return run;
}

beforeEach(() => {
  db = new AviCopilotDb(`agent-step-${crypto.randomUUID()}`);
  requests = [];
  saved = undefined;
});

const executor = () =>
  agentStepExecutor(
    {
      runForWorkflow: async request => {
        requests.push(request);
        return agentRun('queued');
      },
    },
    db,
    () => 1000,
  );

describe('step.agent', () => {
  it('starts the named agent on the step task, once, and waits without holding the routine', async () => {
    const outcome = await executor().execute(context(null));
    expect(requests).toEqual([
      {
        agent: 'Scout',
        task: 'Find three papers',
        workflowName: 'Morning',
        workspaceId: 'ws-1',
        tainted: true,
        firingKey: 'workflow:wrun-1:ask',
      },
    ]);
    expect(saved).toEqual({ agentRunId: 'arun-1' });
    expect(outcome).toMatchObject({ kind: 'park', until: 1000 + AGENT_STEP_POLL_MS, waitingUser: false });
  });

  it('says the step waits for the user while the agent does', async () => {
    await agentRun('waiting_user');
    const outcome = await executor().execute(context({ agentRunId: 'arun-1' }));
    expect(outcome).toMatchObject({ kind: 'park', waitingUser: true });
    expect(requests).toEqual([]);
  });

  it('passes on what the agent found, tainted, with its cost', async () => {
    await agentRun('succeeded');
    const outcome = await executor().execute(context({ agentRunId: 'arun-1' }));
    expect(outcome).toEqual({
      kind: 'done',
      output: 'Three papers: a, b, c',
      tainted: true,
      usage: { inputTokens: 40, outputTokens: 4, costUsd: 0.01 },
    });
  });

  it('fails plainly when the agent was refused, and as unknown when it stopped part way', async () => {
    await agentRun('failed', { error: { kind: 'budget', message: 'Spent for today' } }, false);
    await expect(executor().execute(context({ agentRunId: 'arun-1' }))).rejects.toMatchObject({
      kind: 'invalid',
      message: 'Spent for today',
    });
    await agentRun('failed', { error: { kind: 'failed', message: 'Tab closed' } }, true);
    await expect(executor().execute(context({ agentRunId: 'arun-1' }))).rejects.toMatchObject({ kind: 'unknown' });
    await agentRun('cancelled');
    await expect(executor().execute(context({ agentRunId: 'arun-1' }))).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('needs an agent name', async () => {
    await expect(executor().execute(context(null, ''))).rejects.toThrow(/names no agent/);
  });
});
