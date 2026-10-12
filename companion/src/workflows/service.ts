import { Cron } from 'croner';
import { isTerminal, localDate, systemClock, WorkflowEngine } from '@engine/engine';
import type { EngineClock, EngineHooks } from '@engine/engine';
import { validateSpec } from '@engine/spec';
import type { WorkflowSpec } from '@engine/spec';
import { MAC_NODE_TYPES } from '@protocol';
import type { WorkflowPutRequest, WorkflowSyncReply } from '@protocol';
import { AppError, fail } from '../errors';
import type { Logger } from '../log';
import type { SandboxManager } from '../sandbox/manager';
import { macExecutors } from './executors';
import type { MacExecutorDeps } from './executors';
import type { KeyStore } from './keys';
import { FileWorkflowStore } from './store';
import type { MacWorkflow } from './store';

/**
 * Routines that run on the Mac, so they go on while Brave is closed. The workflow engine is the
 * extension's own (src/background/workflows/engine.ts, compiled into the companion): the same states,
 * retries, budgets, approvals and recovery. Schedules are checked every 30 s against a persisted next
 * time, with the extension's catch-up window: a time missed by more than two hours (the Mac was asleep
 * or off) is skipped, not run late.
 */

export const TICK_MS = 30_000;
export const CATCH_UP_MS = 2 * 60 * 60_000;
const CONCURRENCY = 2;

export interface MacWorkflowsDeps {
  dataDir: string;
  sandbox: SandboxManager;
  keys: KeyStore;
  log: Logger;
  clock?: EngineClock;
  fetch?: MacExecutorDeps['fetch'];
  lookup?: MacExecutorDeps['lookup'];
}

export function nextScheduledRun(spec: WorkflowSpec, after: number): number | null {
  const trigger = spec.nodes.find(node => node.type === 'trigger.schedule');
  if (!trigger || trigger.type !== 'trigger.schedule') return null;
  const next = new Cron(trigger.cron, { timezone: trigger.timezone, paused: true }).nextRun(new Date(after));
  return next ? next.getTime() : null;
}

export class MacWorkflows {
  readonly store: FileWorkflowStore;
  private readonly engine: WorkflowEngine;
  private readonly clock: EngineClock;
  private readonly running = new Map<string, AbortController>();
  private readonly queue: string[] = [];
  private readonly wakeTimers = new Map<string, NodeJS.Timeout>();
  private ticker: NodeJS.Timeout | null = null;

  constructor(private readonly deps: MacWorkflowsDeps) {
    this.clock = deps.clock ?? systemClock;
    this.store = new FileWorkflowStore(deps.dataDir);
    const executors = macExecutors({
      sandbox: deps.sandbox,
      store: this.store,
      modelFor: id => this.modelFor(id),
      fetch: deps.fetch,
      lookup: deps.lookup,
    });
    this.engine = new WorkflowEngine(this.store, executors, this.hooks(), this.clock);
  }

  private hooks(): EngineHooks {
    return {
      approvalNeeded: async (run, step, node, workflow) => {
        await this.store.pushOutbox({
          kind: 'approval',
          workflowId: workflow.id,
          runId: run.id,
          nodeId: node.id,
          label: node.label,
          detail: node.type === 'step.sandbox' ? node.command.slice(0, 2000) : node.type,
        });
      },
      unknownOutcome: async (run, step, node, workflow) => {
        await this.store.pushOutbox({
          kind: 'inbox',
          workflowId: workflow.id,
          runId: run.id,
          nodeId: node.id,
          title: `Check "${node.label}" in ${workflow.name}`,
          body: 'It was cut off on the Mac while it ran; it may or may not have happened.',
          priority: 'high',
        });
      },
      wakeAt: async (runId, at) => {
        this.wake(runId, at);
      },
      finished: async run => {
        this.deps.log.info('routine run ended', { status: run.status });
      },
      autoPaused: async (workflow, run) => {
        await this.store.pushOutbox({
          kind: 'inbox',
          workflowId: workflow.id,
          runId: run.id,
          nodeId: '',
          title: `${workflow.name} is paused`,
          body: 'It failed three times in a row on the Mac, so it was paused. Look at its runs, then resume it.',
          priority: 'normal',
        });
      },
      // The daily spending cap is the extension's; each run keeps its own budget here
      overBudget: async () => null,
    };
  }

  async start(): Promise<void> {
    await this.store.load();
    const recovered = await this.engine.recover();
    for (const runId of recovered.resume) this.enqueue(runId);
    for (const { runId, at } of recovered.wake) this.wake(runId, at);
    const now = this.clock.now();
    for (const workflow of this.store.allWorkflows()) {
      if (workflow.status === 'active' && workflow.nextRunAt === null) {
        const spec = validateSpec(workflow.spec, now);
        if (spec.ok) await this.store.putWorkflow({ ...workflow, nextRunAt: nextScheduledRun(spec.spec, now) });
      }
    }
    this.ticker = setInterval(() => void this.tick(), TICK_MS);
    this.ticker.unref();
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    for (const controller of this.running.values()) controller.abort();
  }

  stats(): { active: number; running: number } {
    return {
      active: this.store.allWorkflows().filter(workflow => workflow.status === 'active').length,
      running: this.running.size,
    };
  }

  /** Adds or replaces a routine; refuses kinds of step the Mac cannot run. */
  async put(request: WorkflowPutRequest): Promise<MacWorkflow> {
    const now = this.clock.now();
    const check = validateSpec(request.workflow.spec, now);
    if (!check.ok) fail('invalid', `The routine is not valid: ${check.issues[0].message}`);
    const unsupported = check.spec.nodes.filter(node => !(MAC_NODE_TYPES as readonly string[]).includes(node.type));
    if (unsupported.length) {
      fail(
        'invalid',
        `These steps need the browser, so this routine cannot run on the Mac: ${unsupported.map(node => node.label).join(', ')}.`,
      );
    }
    const usesModel = check.spec.nodes.some(node => node.type === 'step.llm');
    if (usesModel && !request.model) fail('invalid', 'This routine thinks (step.llm): send the model it should use.');
    const keyRef = request.model?.apiKey ? `workflow:${request.workflow.id}` : null;
    if (request.model?.apiKey && keyRef) await this.deps.keys.set(keyRef, request.model.apiKey, request.keepKey);
    const previous = this.store.macWorkflow(request.workflow.id);
    // Stored without its key
    const model: MacWorkflow['model'] = request.model
      ? {
          provider: request.model.provider,
          baseUrl: request.model.baseUrl,
          model: request.model.model,
          contextWindow: request.model.contextWindow,
        }
      : null;
    const workflow: MacWorkflow = {
      id: request.workflow.id,
      name: request.workflow.name,
      description: check.spec.description,
      workspaceId: request.workflow.workspaceId,
      agentId: request.workflow.agentId,
      spec: check.spec,
      version: request.workflow.version,
      status: request.workflow.status,
      failuresInRow: previous?.failuresInRow ?? 0,
      lastRunAt: previous?.lastRunAt ?? null,
      lastRunStatus: previous?.lastRunStatus ?? null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      model,
      keyRef: keyRef ?? previous?.keyRef ?? null,
      sandbox: request.sandbox ?? null,
      nextRunAt: request.workflow.status === 'active' ? nextScheduledRun(check.spec, now) : null,
    };
    await this.store.putWorkflow(workflow);
    this.deps.log.info('routine stored', { nodes: check.spec.nodes.length, active: workflow.status === 'active' });
    return workflow;
  }

  async remove(id: string): Promise<void> {
    const workflow = this.store.macWorkflow(id);
    if (!workflow) return;
    for (const run of this.store.runsOf(id)) {
      if (!isTerminal(run.status)) {
        this.running.get(run.id)?.abort();
        await this.engine.cancel(run.id);
      }
    }
    if (workflow.keyRef) await this.deps.keys.delete(workflow.keyRef);
    await this.store.deleteWorkflow(id);
  }

  private async modelFor(workflowId: string) {
    const workflow = this.store.macWorkflow(workflowId);
    if (!workflow?.model) return null;
    const apiKey = workflow.keyRef ? ((await this.deps.keys.get(workflow.keyRef)) ?? undefined) : undefined;
    return { ...workflow.model, apiKey };
  }

  /** Starts a run by hand. */
  async runNow(id: string): Promise<string> {
    const workflow = this.store.macWorkflow(id);
    if (!workflow) fail('not_found', 'The Mac does not have this routine.');
    const run = await this.engine.createRun(workflow, { trigger: { type: 'manual', detail: 'mac' }, attended: false });
    this.enqueue(run.id);
    return run.id;
  }

  async answer(runId: string, nodeId: string, approved: boolean): Promise<void> {
    const run = await this.engine.answer(runId, nodeId, approved);
    if (!run) fail('invalid', 'That step is not waiting for an answer any more.');
    this.enqueue(runId);
  }

  sync(cursor: number): WorkflowSyncReply {
    const changed = this.store.changedSince(cursor);
    return {
      ok: true,
      cursor: changed.cursor,
      runs: changed.runs.map(entry => ({
        run: entry.run as unknown as Record<string, unknown>,
        steps: entry.steps as unknown as Record<string, unknown>[],
      })),
      outbox: changed.outbox,
    };
  }

  ack(ids: string[]): Promise<void> {
    return this.store.ackOutbox(ids);
  }

  /** Fires the schedules that are due (within the catch-up window) and moves each to its next time. */
  async tick(): Promise<void> {
    const now = this.clock.now();
    for (const workflow of this.store.allWorkflows()) {
      if (workflow.status !== 'active' || workflow.nextRunAt === null || workflow.nextRunAt > now) continue;
      const due = workflow.nextRunAt;
      const check = validateSpec(workflow.spec, now);
      await this.store.putWorkflow({ ...workflow, nextRunAt: check.ok ? nextScheduledRun(check.spec, now) : null });
      if (!check.ok) continue;
      if (now - due > CATCH_UP_MS) {
        this.deps.log.info('routine missed its time and waits for the next one');
        continue;
      }
      const today = localDate(now);
      const runsToday = this.store
        .runsOf(workflow.id)
        .filter(run => run.trigger.type === 'schedule' && localDate(run.startedAt) === today).length;
      if (runsToday >= check.spec.budget.maxRunsPerDay) continue;
      const firingKey = `${workflow.id}@${due}`;
      if (this.store.runsOf(workflow.id).some(run => run.firingKey === firingKey)) continue;
      try {
        const run = await this.engine.createRun(workflow, {
          trigger: { type: 'schedule', detail: new Date(due).toISOString() },
          attended: false,
          firingKey,
        });
        this.enqueue(run.id);
      } catch (error) {
        this.deps.log.warn('routine could not start', { error: (error as Error).message });
      }
    }
  }

  private wake(runId: string, at: number): void {
    clearTimeout(this.wakeTimers.get(runId));
    const delay = Math.max(0, Math.min(at - this.clock.now(), 2 ** 31 - 1));
    const timer = setTimeout(() => {
      this.wakeTimers.delete(runId);
      this.enqueue(runId);
    }, delay);
    timer.unref();
    this.wakeTimers.set(runId, timer);
  }

  private enqueue(runId: string): void {
    if (!this.queue.includes(runId) && !this.running.has(runId)) this.queue.push(runId);
    this.drain();
  }

  private drain(): void {
    while (this.running.size < CONCURRENCY && this.queue.length) {
      const runId = this.queue.shift()!;
      const controller = new AbortController();
      this.running.set(runId, controller);
      void this.engine
        .execute(runId, controller.signal)
        .catch(error => {
          const appError = error instanceof AppError ? error : null;
          this.deps.log.error('routine run broke', { kind: appError?.kind ?? 'unknown' });
        })
        .finally(() => {
          this.running.delete(runId);
          this.drain();
        });
    }
  }

  /** Waits until nothing runs or is queued (tests). */
  async idle(): Promise<void> {
    while (this.running.size || this.queue.length) await new Promise(resolve => setTimeout(resolve, 10));
  }
}
