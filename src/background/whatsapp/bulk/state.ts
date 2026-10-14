import { whatsappBulkRunsStore } from '@extension/storage';
import type { BulkRun } from '@extension/storage';

/**
 * The bulk runs, read and changed one change at a time: the runner, the panel's commands and recovery all write
 * the same list, so every change waits for the previous one instead of overwriting it.
 */

// How many finished runs the list keeps, for their reports
const KEEP_FINISHED = 10;

export const ACTIVE_STATUSES: BulkRun['status'][] = ['running', 'paused', 'waiting_tab'];

let queue: Promise<unknown> = Promise.resolve();

function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

export async function listRuns(): Promise<BulkRun[]> {
  return (await whatsappBulkRunsStore.get()) ?? [];
}

export async function getRun(id: string): Promise<BulkRun | undefined> {
  return (await listRuns()).find(run => run.id === id);
}

function trim(runs: BulkRun[]): BulkRun[] {
  const finished = runs.filter(run => ['done', 'stopped', 'declined'].includes(run.status));
  const drop = new Set(finished.slice(KEEP_FINISHED).map(run => run.id));
  return runs.filter(run => !drop.has(run.id));
}

export function addRun(run: BulkRun): Promise<BulkRun> {
  return serial(async () => {
    await whatsappBulkRunsStore.set(trim([run, ...(await listRuns()).filter(other => other.id !== run.id)]));
    return run;
  });
}

/**
 * Changes one run. `change` gets a copy and returns the new run, or null to leave it as it is.
 * Returns the run as stored afterwards (undefined when there is no such run).
 */
export function updateRun(id: string, change: (run: BulkRun) => BulkRun | null): Promise<BulkRun | undefined> {
  return serial(async () => {
    const runs = await listRuns();
    const index = runs.findIndex(run => run.id === id);
    if (index === -1) return undefined;
    const next = change(structuredClone(runs[index]));
    if (!next) return runs[index];
    next.updatedAt = Date.now();
    runs[index] = next;
    await whatsappBulkRunsStore.set(runs);
    return next;
  });
}

export function removeRuns(ids: string[]): Promise<void> {
  return serial(async () => {
    await whatsappBulkRunsStore.set((await listRuns()).filter(run => !ids.includes(run.id)));
  });
}
