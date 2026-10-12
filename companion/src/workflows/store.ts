import { randomBytes } from 'node:crypto';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineStore } from '@engine/engine';
import type { RunRecord, RunStep, WorkflowRecord } from '@extension/storage';
import type { ModelConfig, OutboxItem, SandboxPolicy } from '@protocol';
import { privateDir } from '../config';

/**
 * The Mac's copy of the routines it runs, their runs and steps, and the outbox of things for the extension
 * (Inbox items, brief sections, notifications, approvals). JSON files under `<data>/workflows`, written
 * whole on every change (they are small). Every change bumps a counter, so the extension can ask for
 * "what changed since" when it reconnects.
 */

export interface MacWorkflow extends WorkflowRecord {
  // For step.llm; the key is never here (see keys.ts)
  model: Omit<ModelConfig, 'apiKey'> | null;
  keyRef: string | null;
  sandbox: Partial<SandboxPolicy> | null;
  // When its schedule fires next (persisted, so a restart keeps the catch-up window honest)
  nextRunAt: number | null;
}

// An outbox item before it has an id and a time (Omit over each member of the union)
export type OutboxDraft = OutboxItem extends infer Item
  ? Item extends unknown
    ? Omit<Item, 'id' | 'at'>
    : never
  : never;

interface StoredRun {
  run: RunRecord;
  steps: RunStep[];
  changed: number;
}

const KEEP_RUNS = 300;

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

export class FileWorkflowStore implements EngineStore {
  private readonly dir: string;
  private readonly runsDir: string;
  private workflows = new Map<string, MacWorkflow>();
  private runs = new Map<string, StoredRun>();
  private outbox: OutboxItem[] = [];
  private seq = 0;
  // Writes for one file go one after the other
  private readonly writes = new Map<string, Promise<void>>();

  constructor(dataDir: string) {
    this.dir = privateDir(join(dataDir, 'workflows'));
    this.runsDir = privateDir(join(this.dir, 'runs'));
  }

  async load(): Promise<void> {
    const read = async <T>(path: string, fallback: T): Promise<T> => {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as T;
      } catch {
        return fallback;
      }
    };
    const state = await read<{ workflows: MacWorkflow[]; outbox: OutboxItem[]; seq: number }>(
      join(this.dir, 'state.json'),
      {
        workflows: [],
        outbox: [],
        seq: 0,
      },
    );
    this.workflows = new Map(state.workflows.map(workflow => [workflow.id, workflow]));
    this.outbox = state.outbox;
    this.seq = state.seq;
    for (const name of await readdir(this.runsDir)) {
      if (!name.endsWith('.json')) continue;
      const stored = await read<StoredRun | null>(join(this.runsDir, name), null);
      if (stored?.run?.id) this.runs.set(stored.run.id, stored);
    }
  }

  private queueWrite(path: string, value: () => unknown): Promise<void> {
    const before = this.writes.get(path) ?? Promise.resolve();
    const next = before.then(() => writeAtomic(path, value()));
    this.writes.set(
      path,
      next.catch(() => {}),
    );
    return next;
  }

  private saveState(): Promise<void> {
    return this.queueWrite(join(this.dir, 'state.json'), () => ({
      workflows: [...this.workflows.values()],
      outbox: this.outbox,
      seq: this.seq,
    }));
  }

  private saveRun(id: string): Promise<void> {
    const stored = this.runs.get(id);
    if (!stored) return Promise.resolve();
    stored.changed = ++this.seq;
    return Promise.all([
      this.queueWrite(join(this.runsDir, `${id}.json`), () => this.runs.get(id)),
      this.saveState(),
    ]).then(() => undefined);
  }

  // ── Workflows ──

  allWorkflows(): MacWorkflow[] {
    return [...this.workflows.values()];
  }

  macWorkflow(id: string): MacWorkflow | undefined {
    return this.workflows.get(id);
  }

  async putWorkflow(workflow: MacWorkflow): Promise<void> {
    this.workflows.set(workflow.id, workflow);
    await this.saveState();
  }

  async deleteWorkflow(id: string): Promise<void> {
    this.workflows.delete(id);
    await this.saveState();
  }

  // ── EngineStore ──

  async getWorkflow(id: string): Promise<WorkflowRecord | undefined> {
    return this.workflows.get(id);
  }

  async updateWorkflow(id: string, changes: Partial<WorkflowRecord>): Promise<void> {
    const workflow = this.workflows.get(id);
    if (!workflow) return;
    this.workflows.set(id, { ...workflow, ...changes, updatedAt: Date.now() });
    await this.saveState();
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    return this.runs.get(id)?.run;
  }

  async addRun(run: RunRecord, steps: RunStep[]): Promise<void> {
    this.runs.set(run.id, { run, steps, changed: 0 });
    await this.saveRun(run.id);
    await this.prune();
  }

  async updateRun(id: string, changes: Partial<RunRecord>): Promise<void> {
    const stored = this.runs.get(id);
    if (!stored) return;
    stored.run = { ...stored.run, ...changes };
    await this.saveRun(id);
  }

  async openRuns(): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .map(stored => stored.run)
      .filter(run => run.status === 'queued' || run.status === 'running' || run.status === 'waiting_user');
  }

  async listSteps(runId: string): Promise<RunStep[]> {
    return [...(this.runs.get(runId)?.steps ?? [])].sort((a, b) => a.index - b.index);
  }

  async putStep(step: RunStep): Promise<void> {
    const stored = this.runs.get(step.runId);
    if (!stored) return;
    stored.steps = [...stored.steps.filter(item => item.id !== step.id), step];
    await this.saveRun(step.runId);
  }

  async updateStep(id: string, changes: Partial<RunStep>): Promise<void> {
    for (const stored of this.runs.values()) {
      const index = stored.steps.findIndex(step => step.id === id);
      if (index < 0) continue;
      stored.steps[index] = { ...stored.steps[index], ...changes };
      await this.saveRun(stored.run.id);
      return;
    }
  }

  // ── For the extension ──

  /** Runs that changed after `cursor`, and the outbox. */
  changedSince(cursor: number): { cursor: number; runs: { run: RunRecord; steps: RunStep[] }[]; outbox: OutboxItem[] } {
    const runs = [...this.runs.values()]
      .filter(stored => stored.changed > cursor)
      .sort((a, b) => a.changed - b.changed)
      .slice(0, 100);
    const last = runs.length === 100 ? runs[runs.length - 1].changed : this.seq;
    return {
      cursor: last,
      runs: runs.map(stored => ({ run: stored.run, steps: [...stored.steps].sort((a, b) => a.index - b.index) })),
      outbox: [...this.outbox],
    };
  }

  async pushOutbox(item: OutboxDraft): Promise<void> {
    this.outbox.push({ ...item, id: randomBytes(8).toString('hex'), at: Date.now() } as OutboxItem);
    // An outbox that nobody collects stays small
    if (this.outbox.length > 500) this.outbox = this.outbox.slice(-500);
    this.seq++;
    await this.saveState();
  }

  async ackOutbox(ids: string[]): Promise<void> {
    const done = new Set(ids);
    this.outbox = this.outbox.filter(item => !done.has(item.id));
    await this.saveState();
  }

  runsOf(workflowId: string): RunRecord[] {
    return [...this.runs.values()].map(stored => stored.run).filter(run => run.workflowId === workflowId);
  }

  private async prune(): Promise<void> {
    if (this.runs.size <= KEEP_RUNS) return;
    const ended = [...this.runs.values()]
      .filter(stored => stored.run.endedAt !== null)
      .sort((a, b) => a.run.startedAt - b.run.startedAt);
    for (const stored of ended.slice(0, this.runs.size - KEEP_RUNS)) {
      this.runs.delete(stored.run.id);
      await rm(join(this.runsDir, `${stored.run.id}.json`), { force: true });
    }
  }
}
