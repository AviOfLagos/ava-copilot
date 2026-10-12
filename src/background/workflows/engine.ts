import { abortableSleep, AppError, toAppError, withRetry } from '@extension/shared';
import type { RetryPolicy } from '@extension/shared';
import type { RunRecord, RunStatus, RunStep, RunStepStatus, WorkflowRecord } from '@extension/storage';
import { DATA_FIELDS, groupOf, incomingEdges, isSideEffect, parseSpec, topoOrder, validateSpec } from './spec';
import type { ConditionOp, NodeOf, WorkflowNode, WorkflowSpec } from './spec';
import { forStorage, resolveTemplate } from './template';

/**
 * Runs a workflow as a persisted state machine: a run (queued → running → waiting_user → succeeded |
 * failed | cancelled | interrupted | unknown_outcome) and one step per node, each saved as it changes, so
 * the panel lights the diagram live and a restarted background picks up where it was.
 *
 * Pure TypeScript: storage, step work, time and side channels (Inbox, jobs) come in from outside, so the
 * Mac companion can run the same engine later with its own.
 *
 * Rules it keeps:
 * - steps run one at a time, in an order where each follows what it depends on;
 * - only steps safe to repeat are retried, with back-off, on errors that may pass; model calls retry on
 *   their own and are not wrapped again;
 * - a step that acts on the user's behalf (sends, writes, runs code) never runs without their click: the run
 *   waits and an Inbox item asks; it is never retried, and when it is cut off its outcome is unknown;
 * - every attempt counts against the run's budget; model steps also against its model and token budget
 *   and the user's daily cap;
 * - a run that pulled in outside content is tainted, and stays so;
 * - three failed runs in a row pause the workflow.
 */

export const LEASE_MS = 60_000;
export const HEARTBEAT_MS = 20_000;
// A run cut off by a restart this recently is resumed; an older one is marked interrupted
export const RESUME_WINDOW_MS = 15 * 60_000;
export const AUTO_PAUSE_AFTER = 3;
const STORED_INPUT_CHARS = 60_000;

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'unknown_outcome',
]);

export const isTerminal = (status: RunStatus): boolean => TERMINAL.has(status);

export interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  modelCalls: number;
}

export type StepOutcome =
  | { kind: 'done'; output: unknown; tainted?: boolean; usage?: Partial<StepUsage> }
  // The step must wait, e.g. its browser task waits for the user's click: the run is put away and woken later
  | { kind: 'park'; until: number; waitingUser: boolean; state?: unknown; tainted?: boolean };

export interface StepContext {
  node: WorkflowNode;
  // The node's fields with their places filled
  params: Record<string, unknown>;
  run: RunRecord;
  workflow: WorkflowRecord;
  // What an earlier attempt saved, to carry on from there
  state: unknown;
  saveState: (state: unknown) => Promise<void>;
  signal: AbortSignal;
}

export interface StepExecutor {
  // Safe to repeat: retried on errors that may pass. Null: tried once (model calls retry on their own)
  retry: Omit<RetryPolicy, 'signal' | 'onRetry' | 'sleep' | 'random'> | null;
  // Brings in content from outside: the run is tainted from then on
  taints: boolean;
  // Can carry on after a restart from its saved state, instead of being cut off
  resumable?: boolean;
  // Calls a model: counted against the run's model budget and the user's daily cap
  usesModel?: boolean;
  execute: (context: StepContext) => Promise<StepOutcome>;
}

export interface EngineStore {
  getWorkflow(id: string): Promise<WorkflowRecord | undefined>;
  updateWorkflow(id: string, changes: Partial<WorkflowRecord>): Promise<void>;
  getRun(id: string): Promise<RunRecord | undefined>;
  addRun(run: RunRecord, steps: RunStep[]): Promise<void>;
  updateRun(id: string, changes: Partial<RunRecord>): Promise<void>;
  // Runs not finished: queued, running or waiting for the user
  openRuns(): Promise<RunRecord[]>;
  listSteps(runId: string): Promise<RunStep[]>;
  putStep(step: RunStep): Promise<void>;
  updateStep(id: string, changes: Partial<RunStep>): Promise<void>;
}

export interface EngineHooks {
  // A step that acts for the user waits for their click: ask where they will see it
  approvalNeeded(run: RunRecord, step: RunStep, node: WorkflowNode, workflow: WorkflowRecord): Promise<void>;
  // A step that acts for the user was cut off: they check what happened
  unknownOutcome(run: RunRecord, step: RunStep, node: WorkflowNode, workflow: WorkflowRecord): Promise<void>;
  // Wake the run again at this time
  wakeAt(runId: string, at: number): Promise<void>;
  finished(run: RunRecord, workflow: WorkflowRecord | undefined): Promise<void>;
  autoPaused(workflow: WorkflowRecord, run: RunRecord): Promise<void>;
  // A sentence when the user's daily spending cap is reached, else null
  overBudget(): Promise<string | null>;
}

export interface EngineClock {
  now(): number;
  every(ms: number, tick: () => void): () => void;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: EngineClock = {
  now: () => Date.now(),
  every(ms, tick) {
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  },
  sleep: abortableSleep,
};

export interface RunOptions {
  trigger: { type: string; detail: string };
  attended: boolean;
  tainted?: boolean;
  firingKey?: string | null;
}

export interface Recovered {
  // Runs to carry on now
  resume: string[];
  // Runs put away, to wake at a time
  wake: { runId: string; at: number }[];
}

/** "2026-10-12" in local time. */
export function localDate(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** A node's fields with the places in its data fields filled from the scope. */
export function resolveParams(node: WorkflowNode, scope: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = { ...node };
  for (const field of DATA_FIELDS[node.type] ?? []) {
    const value = params[field];
    if (typeof value === 'string') params[field] = resolveTemplate(value, scope);
  }
  return params;
}

/** A condition's answer. Plain comparisons only: no expressions, nothing evaluated. */
export function evaluateCondition(op: ConditionOp, left: string, right: string): boolean {
  const a = left.trim();
  const b = right.trim();
  switch (op) {
    case 'contains':
      return a.toLowerCase().includes(b.toLowerCase());
    case 'not_contains':
      return !a.toLowerCase().includes(b.toLowerCase());
    case 'equals':
      return a.toLowerCase() === b.toLowerCase();
    case 'not_equals':
      return a.toLowerCase() !== b.toLowerCase();
    case 'greater_than':
    case 'less_than': {
      const x = Number(a);
      const y = Number(b);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      return op === 'greater_than' ? x > y : x < y;
    }
    case 'is_empty':
      return a === '' || a === '[]' || a === '{}';
    case 'is_not_empty':
      return !(a === '' || a === '[]' || a === '{}');
  }
}

// Steps the engine runs itself: they read only what the run already has
const conditionExecutor: StepExecutor = {
  retry: null,
  taints: false,
  async execute({ params }) {
    const node = params as unknown as NodeOf<'step.condition'>;
    return { kind: 'done', output: { value: evaluateCondition(node.op, node.left, node.right ?? '') } };
  },
};

function newStep(runId: string, node: WorkflowNode, index: number): RunStep {
  return {
    id: crypto.randomUUID(),
    runId,
    nodeId: node.id,
    index,
    status: 'queued',
    sideEffect: isSideEffect(node),
    attempts: 0,
    startedAt: null,
    endedAt: null,
    input: null,
    output: null,
    error: null,
    approval: null,
    state: null,
    tainted: false,
  };
}

// A side effect that failed this way may still have happened
const UNCERTAIN = new Set(['network', 'timeout', 'unknown']);

export class WorkflowEngine {
  constructor(
    private readonly store: EngineStore,
    private readonly executors: (type: WorkflowNode['type']) => StepExecutor | undefined,
    private readonly hooks: EngineHooks,
    private readonly clock: EngineClock = systemClock,
  ) {}

  private executorFor(type: WorkflowNode['type']): StepExecutor | undefined {
    return type === 'step.condition' ? conditionExecutor : this.executors(type);
  }

  /** A queued run of a workflow's current version, with all its steps, so the diagram shows it at once. */
  async createRun(workflow: WorkflowRecord, options: RunOptions): Promise<RunRecord> {
    const now = this.clock.now();
    const check = validateSpec(workflow.spec, now);
    if (!check.ok) throw new AppError('invalid', `The workflow is not valid: ${check.issues[0].message}`);
    const run: RunRecord = {
      id: crypto.randomUUID(),
      kind: 'workflow',
      workflowId: workflow.id,
      agentId: workflow.agentId,
      workspaceId: workflow.workspaceId,
      trigger: options.trigger,
      status: 'queued',
      tainted: options.tainted ?? false,
      startedAt: now,
      endedAt: null,
      leaseUntil: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      error: null,
      attended: options.attended,
      spec: check.spec,
      specVersion: workflow.version,
      firingKey: options.firingKey ?? null,
      modelCalls: 0,
    };
    const nodes = new Map(check.spec.nodes.map(node => [node.id, node]));
    const steps = (topoOrder(check.spec) ?? []).map((id, index) => newStep(run.id, nodes.get(id)!, index));
    await this.store.addRun(run, steps);
    return run;
  }

  /**
   * Runs a run until it ends or must wait. Safe to call again on a run that was put away or cut off: steps
   * that finished are kept, and the rest carry on.
   */
  async execute(runId: string, signal: AbortSignal): Promise<RunRecord | undefined> {
    let run = await this.store.getRun(runId);
    if (!run || isTerminal(run.status)) return run;
    const workflow = run.workflowId ? await this.store.getWorkflow(run.workflowId) : undefined;
    if (!workflow) return this.finish(run, 'failed', { kind: 'not_found', message: 'Its workflow was deleted.' });
    const spec = parseSpec(run.spec);
    const order = spec && topoOrder(spec);
    if (!spec || !order) return this.finish(run, 'failed', { kind: 'invalid', message: 'Its workflow is not valid.' });

    const nodes = new Map(spec.nodes.map(node => [node.id, node]));
    const byNode = new Map((await this.store.listSteps(runId)).map(step => [step.nodeId, step]));
    for (const [index, id] of order.entries()) {
      if (!byNode.has(id)) {
        const step = newStep(runId, nodes.get(id)!, index);
        await this.store.putStep(step);
        byNode.set(id, step);
      }
    }

    run = await this.patchRun(run, {
      status: run.status === 'waiting_user' ? 'waiting_user' : 'running',
      leaseUntil: this.clock.now() + LEASE_MS,
    });
    const stopHeartbeat = this.clock.every(HEARTBEAT_MS, () => {
      void this.store.updateRun(runId, { leaseUntil: this.clock.now() + LEASE_MS }).catch(() => {});
    });
    try {
      for (const id of order) {
        const node = nodes.get(id)!;
        let step = byNode.get(id)!;
        if (step.status === 'succeeded' || step.status === 'skipped') continue;
        if (step.status !== 'queued' && step.status !== 'running' && step.status !== 'waiting_user') {
          // A step already ended badly: the run ends the same way
          return await this.finish(run, step.status, step.error ?? { kind: step.status, message: node.label });
        }
        if (signal.aborted) return await this.stop(run, step);

        if (!this.shouldRun(spec, node, byNode, run)) {
          byNode.set(id, await this.patchStep(step, { status: 'skipped', endedAt: this.clock.now() }));
          continue;
        }

        // A trigger only says the run started
        if (groupOf(node.type) === 'trigger') {
          const now = this.clock.now();
          step = await this.patchStep(step, {
            status: 'succeeded',
            startedAt: now,
            endedAt: now,
            output: {
              firedAt: new Date(run.startedAt).toISOString(),
              by: run.trigger.type,
              detail: run.trigger.detail,
            },
          });
          byNode.set(id, step);
          continue;
        }

        // A kind with no executor is one still being built (agents, connectors, the Mac companion)
        const executor = this.executorFor(node.type);
        if (!executor) {
          const error = {
            kind: 'unavailable',
            message: `"${node.label}" is a kind of step that is not available yet.`,
          };
          await this.patchStep(step, { status: 'failed', error, endedAt: this.clock.now() });
          return await this.finish(run, 'failed', error);
        }

        if (isSideEffect(node)) {
          if (step.approval === 'declined') {
            await this.patchStep(step, { status: 'cancelled', endedAt: this.clock.now() });
            return await this.finish(run, 'cancelled', { kind: 'cancelled', message: `You declined "${node.label}".` });
          }
          if (step.approval !== 'approved') {
            step = await this.patchStep(step, { status: 'waiting_user', approval: 'pending' });
            run = await this.patchRun(run, { status: 'waiting_user', leaseUntil: null });
            await this.safely(() => this.hooks.approvalNeeded(run!, step, node, workflow));
            return run;
          }
        }

        // A step picking up from a saved state (its browser task) is not a new attempt
        const resuming = step.state !== null && step.state !== undefined;
        if (!resuming) {
          const blocked = await this.budgetBlock(spec, run, byNode, executor);
          if (blocked) {
            await this.patchStep(step, { status: 'failed', error: blocked, endedAt: this.clock.now() });
            return await this.finish(run, 'failed', blocked);
          }
        }

        const params = resolveParams(node, this.scope(run, workflow, byNode));
        if (!resuming) {
          step = await this.patchStep(step, {
            status: 'running',
            startedAt: step.startedAt ?? this.clock.now(),
            input: forStorage(params, STORED_INPUT_CHARS),
            error: null,
          });
        }
        if (run.status !== 'running' && !resuming) run = await this.patchRun(run, { status: 'running' });

        let outcome: StepOutcome;
        try {
          ({ outcome, step } = await this.attempt(executor, node, step, params, run, workflow, signal, resuming));
        } catch (thrown) {
          const error = toAppError(thrown);
          if (signal.aborted || error.kind === 'cancelled') return await this.stop(run, step);
          const record = { kind: error.kind, message: error.message.slice(0, 500) };
          if (isSideEffect(node) && UNCERTAIN.has(error.kind)) {
            step = await this.patchStep(step, { status: 'unknown_outcome', error: record, endedAt: this.clock.now() });
            await this.safely(() => this.hooks.unknownOutcome(run!, step, node, workflow));
            return await this.finish(run, 'unknown_outcome', {
              kind: 'unknown_outcome',
              message: `${node.label}: ${record.message}`,
            });
          }
          await this.patchStep(step, { status: 'failed', error: record, endedAt: this.clock.now() });
          return await this.finish(run, 'failed', { kind: error.kind, message: `${node.label}: ${record.message}` });
        }

        const tainted = executor.taints || Boolean(outcome.tainted);
        if (outcome.kind === 'park') {
          step = await this.patchStep(step, {
            status: outcome.waitingUser ? 'waiting_user' : 'running',
            state: outcome.state === undefined ? step.state : outcome.state,
            tainted: step.tainted || tainted,
          });
          run = await this.patchRun(run, {
            status: outcome.waitingUser ? 'waiting_user' : 'running',
            tainted: run.tainted || tainted,
            leaseUntil: null,
          });
          await this.hooks.wakeAt(runId, outcome.until);
          return run;
        }

        const usage = outcome.usage ?? {};
        step = await this.patchStep(step, {
          status: 'succeeded',
          output: forStorage(outcome.output),
          endedAt: this.clock.now(),
          tainted,
        });
        byNode.set(id, step);
        run = await this.patchRun(run, {
          status: 'running',
          tainted: run.tainted || tainted,
          inputTokens: run.inputTokens + (usage.inputTokens ?? 0),
          outputTokens: run.outputTokens + (usage.outputTokens ?? 0),
          costUsd: run.costUsd + (usage.costUsd ?? 0),
          modelCalls: (run.modelCalls ?? 0) + (usage.modelCalls ?? 0),
        });
      }
      return await this.finish(run, 'succeeded', null);
    } finally {
      stopHeartbeat();
    }
  }

  /** The user answered a step that waits for their click. The run is queued again; null when nothing waited. */
  async answer(runId: string, nodeId: string, approved: boolean): Promise<RunRecord | null> {
    const run = await this.store.getRun(runId);
    if (!run || run.status !== 'waiting_user') return null;
    const step = (await this.store.listSteps(runId)).find(item => item.nodeId === nodeId);
    if (!step || step.approval !== 'pending') return null;
    await this.store.updateStep(step.id, { approval: approved ? 'approved' : 'declined', status: 'queued' });
    await this.store.updateRun(runId, { status: 'queued' });
    return { ...run, status: 'queued' };
  }

  /** Ends a run that is not being worked on right now (queued, put away, or waiting for the user). */
  async cancel(runId: string): Promise<RunRecord | undefined> {
    const run = await this.store.getRun(runId);
    if (!run || isTerminal(run.status)) return run;
    for (const step of await this.store.listSteps(runId)) {
      if (step.status === 'running' || step.status === 'waiting_user') {
        await this.store.updateStep(step.id, { status: 'cancelled', endedAt: this.clock.now() });
      }
    }
    return this.finish(run, 'cancelled', { kind: 'cancelled', message: 'Stopped.' });
  }

  /**
   * After the background restarted, nothing runs any more: queued runs carry on, recent runs that were
   * cut off resume (a step safe to repeat runs again, a browser task picks up its chat), a step that acts
   * for the user is marked unknown and the user asked, and older runs are marked interrupted.
   */
  async recover(): Promise<Recovered> {
    const now = this.clock.now();
    const recovered: Recovered = { resume: [], wake: [] };
    for (const run of await this.store.openRuns()) {
      if (run.status === 'queued') {
        recovered.resume.push(run.id);
        continue;
      }
      const steps = await this.store.listSteps(run.id);
      if (run.status === 'waiting_user') {
        // Approvals wait for the user; a step put away waits for its wake-up, which is checked again now
        if (steps.some(step => step.status === 'waiting_user' && step.approval !== 'pending')) {
          recovered.wake.push({ runId: run.id, at: now });
        }
        continue;
      }
      const workflow = run.workflowId ? await this.store.getWorkflow(run.workflowId) : undefined;
      const nodes = new Map((parseSpec(run.spec)?.nodes ?? []).map(node => [node.id, node]));
      const recent = now - (run.leaseUntil ?? run.startedAt) < RESUME_WINDOW_MS;
      let cutOff: { step: RunStep; node: WorkflowNode } | null = null;
      for (const step of steps.filter(item => item.status === 'running')) {
        const node = nodes.get(step.nodeId);
        const executor = node && this.executorFor(node.type);
        if (step.sideEffect) {
          const error = {
            kind: 'unknown_outcome',
            message: 'The browser stopped while this step ran; it may or may not have happened.',
          };
          await this.store.updateStep(step.id, { status: 'unknown_outcome', error, endedAt: now });
          if (node) cutOff = { step: { ...step, status: 'unknown_outcome', error }, node };
        } else if (recent && executor?.resumable && step.state) {
          // Carries on from its saved state
        } else {
          await this.store.updateStep(step.id, recent ? { status: 'queued' } : { status: 'interrupted', endedAt: now });
        }
      }
      if (cutOff) {
        if (workflow) await this.safely(() => this.hooks.unknownOutcome(run, cutOff!.step, cutOff!.node, workflow));
        await this.finish(run, 'unknown_outcome', {
          kind: 'unknown_outcome',
          message: `${cutOff.node.label}: it may or may not have happened.`,
        });
      } else if (recent) {
        await this.store.updateRun(run.id, { status: 'queued', leaseUntil: null });
        recovered.resume.push(run.id);
      } else {
        await this.finish(run, 'interrupted', { kind: 'interrupted', message: 'The browser stopped while it ran.' });
      }
    }
    return recovered;
  }

  /** Whether a node runs in this run: a trigger that fired, or a step with at least one live way in. */
  private shouldRun(spec: WorkflowSpec, node: WorkflowNode, byNode: Map<string, RunStep>, run: RunRecord): boolean {
    if (groupOf(node.type) === 'trigger') return this.firedTriggers(spec, run).has(node.id);
    return incomingEdges(spec, node.id).some(edge => {
      const parent = byNode.get(edge.from);
      if (!parent || parent.status !== 'succeeded') return false;
      if (!edge.when) return true;
      const value = (parent.output as { value?: unknown } | null)?.value;
      return String(Boolean(value)) === edge.when;
    });
  }

  /** The triggers that started this run: those of its kind, or all of them when none is (e.g. Run now). */
  private firedTriggers(spec: WorkflowSpec, run: RunRecord): Set<string> {
    const triggers = spec.nodes.filter(node => groupOf(node.type) === 'trigger');
    const event = run.trigger.detail.split(':')[0];
    const matching = triggers.filter(node => {
      switch (run.trigger.type) {
        case 'schedule':
          return node.type === 'trigger.schedule';
        case 'event':
          return node.type === 'trigger.event' && node.event === event;
        case 'tab':
          return node.type === 'trigger.tab';
        default:
          return node.type === 'trigger.manual';
      }
    });
    return new Set((matching.length ? matching : triggers).map(node => node.id));
  }

  private scope(run: RunRecord, workflow: WorkflowRecord, byNode: Map<string, RunStep>): Record<string, unknown> {
    const steps: Record<string, { output: unknown }> = {};
    for (const [id, step] of byNode) if (step.status === 'succeeded') steps[id] = { output: step.output };
    return {
      steps,
      run: {
        date: localDate(run.startedAt),
        startedAt: new Date(run.startedAt).toISOString(),
        trigger: run.trigger.type,
      },
      workflow: { name: workflow.name },
    };
  }

  /** Why the next attempt may not run (a limit reached), or null. */
  private async budgetBlock(
    spec: WorkflowSpec,
    run: RunRecord,
    byNode: Map<string, RunStep>,
    executor: StepExecutor,
  ): Promise<{ kind: string; message: string } | null> {
    const attempts = [...byNode.values()].reduce((sum, step) => sum + step.attempts, 0);
    if (attempts >= spec.budget.maxSteps) {
      return { kind: 'budget', message: `It reached its limit of ${spec.budget.maxSteps} steps per run.` };
    }
    if (!executor.usesModel) return null;
    if ((run.modelCalls ?? 0) >= spec.budget.maxModelCalls) {
      return { kind: 'budget', message: `It reached its limit of ${spec.budget.maxModelCalls} model calls per run.` };
    }
    if (run.inputTokens + run.outputTokens >= spec.budget.maxTokens) {
      return { kind: 'budget', message: `It reached its limit of ${spec.budget.maxTokens} tokens per run.` };
    }
    const over = await this.hooks.overBudget();
    return over ? { kind: 'budget', message: over } : null;
  }

  /** One step's work: retried with back-off when it is safe to repeat, once otherwise. */
  private async attempt(
    executor: StepExecutor,
    node: WorkflowNode,
    step: RunStep,
    params: Record<string, unknown>,
    run: RunRecord,
    workflow: WorkflowRecord,
    signal: AbortSignal,
    resuming: boolean,
  ): Promise<{ outcome: StepOutcome; step: RunStep }> {
    let current = step;
    let first = true;
    const once = async (): Promise<StepOutcome> => {
      if (!resuming || !first) current = await this.patchStep(current, { attempts: current.attempts + 1 });
      first = false;
      return executor.execute({
        node,
        params,
        run,
        workflow,
        state: current.state ?? null,
        saveState: async state => {
          current = await this.patchStep(current, { state });
        },
        signal,
      });
    };
    const outcome =
      executor.retry && !isSideEffect(node)
        ? await withRetry(() => once(), {
            ...executor.retry,
            signal,
            sleep: (ms, abort) => this.clock.sleep(ms, abort),
          })
        : await once();
    return { outcome, step: current };
  }

  /** Ends a run stopped by the user (or the job that ran it). */
  private async stop(run: RunRecord, step: RunStep): Promise<RunRecord> {
    if (step.status === 'running' || step.status === 'waiting_user') {
      await this.patchStep(step, { status: 'cancelled', endedAt: this.clock.now() });
    }
    return this.finish(run, 'cancelled', { kind: 'cancelled', message: 'Stopped.' });
  }

  private async finish(
    run: RunRecord,
    status: RunStatus | RunStepStatus,
    error: { kind: string; message: string } | null,
  ): Promise<RunRecord> {
    const endedAt = this.clock.now();
    const final: RunStatus = status === 'skipped' ? 'succeeded' : status;
    const ended = await this.patchRun(run, { status: final, error, endedAt, leaseUntil: null });
    let workflow = ended.workflowId ? await this.store.getWorkflow(ended.workflowId) : undefined;
    if (workflow) {
      const failed = final === 'failed' || final === 'unknown_outcome';
      const failuresInRow = final === 'succeeded' ? 0 : failed ? workflow.failuresInRow + 1 : workflow.failuresInRow;
      const pause = failed && failuresInRow >= AUTO_PAUSE_AFTER && workflow.status === 'active';
      const changes: Partial<WorkflowRecord> = {
        lastRunAt: endedAt,
        lastRunStatus: final,
        failuresInRow,
        ...(pause ? { status: 'paused' as const } : {}),
      };
      await this.store.updateWorkflow(workflow.id, changes);
      workflow = { ...workflow, ...changes };
      if (pause) await this.safely(() => this.hooks.autoPaused(workflow!, ended));
    }
    await this.safely(() => this.hooks.finished(ended, workflow));
    return ended;
  }

  private async patchRun(run: RunRecord, changes: Partial<RunRecord>): Promise<RunRecord> {
    await this.store.updateRun(run.id, changes);
    return { ...run, ...changes };
  }

  private async patchStep(step: RunStep, changes: Partial<RunStep>): Promise<RunStep> {
    await this.store.updateStep(step.id, changes);
    return { ...step, ...changes };
  }

  // Side channels (Inbox, jobs, the brief) must not break a run
  private async safely(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      console.warn('[Workflows] A follow-up of the run failed', error);
    }
  }
}
