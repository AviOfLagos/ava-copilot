import { db as defaultDb } from '@extension/storage';
import type { AviCopilotDb, RunRecord, RunStep, WorkflowRecord } from '@extension/storage';
import type { EngineStore } from './engine';

// Runs kept per workflow; older ones and their steps are removed when a run ends
export const RUNS_KEPT = 30;

/** The engine's storage, over the extension's database (tests pass their own). */
export function createEngineStore(database: AviCopilotDb = defaultDb): EngineStore {
  return {
    getWorkflow: id => database.workflows.get(id),
    async updateWorkflow(id, changes) {
      await database.workflows.update(id, { ...changes, updatedAt: Date.now() });
    },
    getRun: id => database.runs.get(id),
    async addRun(run: RunRecord, steps: RunStep[]) {
      await database.transaction('rw', database.runs, database.runSteps, async () => {
        await database.runs.add(run);
        await database.runSteps.bulkAdd(steps);
      });
    },
    async updateRun(id, changes) {
      await database.runs.update(id, changes);
    },
    openRuns: () =>
      database.runs
        .where('status')
        .anyOf('queued', 'running', 'waiting_user')
        .filter(run => run.kind === 'workflow')
        .toArray(),
    listSteps: runId => database.runSteps.where('runId').equals(runId).sortBy('index'),
    async putStep(step) {
      await database.runSteps.put(step);
    },
    async updateStep(id, changes) {
      await database.runSteps.update(id, changes);
    },
  };
}

/** A workflow's runs, newest first. */
export async function runsOf(database: AviCopilotDb, workflowId: string): Promise<RunRecord[]> {
  const runs = await database.runs.where('workflowId').equals(workflowId).toArray();
  return runs.sort((a, b) => b.startedAt - a.startedAt);
}

/** Removes a workflow's runs past the newest RUNS_KEPT, with their steps. */
export async function pruneRuns(database: AviCopilotDb, workflowId: string, keep = RUNS_KEPT): Promise<number> {
  const old = (await runsOf(database, workflowId)).slice(keep).filter(run => run.endedAt !== null);
  if (old.length === 0) return 0;
  const ids = old.map(run => run.id);
  await database.transaction('rw', database.runs, database.runSteps, async () => {
    await database.runSteps.where('runId').anyOf(ids).delete();
    await database.runs.bulkDelete(ids);
  });
  return ids.length;
}

/** Removes a workflow with all its runs. */
export async function deleteWorkflow(database: AviCopilotDb, workflowId: string): Promise<void> {
  const ids = (await runsOf(database, workflowId)).map(run => run.id);
  await database.transaction('rw', database.workflows, database.runs, database.runSteps, async () => {
    await database.runSteps.where('runId').anyOf(ids).delete();
    await database.runs.bulkDelete(ids);
    await database.workflows.delete(workflowId);
  });
}

export function newWorkflowRecord(fields: Partial<WorkflowRecord> & Pick<WorkflowRecord, 'name'>): WorkflowRecord {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    description: '',
    workspaceId: null,
    agentId: null,
    spec: null,
    version: 0,
    status: 'draft',
    failuresInRow: 0,
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
    draft: null,
    lastRunStatus: null,
    ...fields,
  };
}
