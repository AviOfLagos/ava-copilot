import { AppError } from '@extension/shared';
import { db as defaultDb } from '@extension/storage';
import type { AviCopilotDb, JobRecord, RunRecord, WorkflowRecord } from '@extension/storage';
import { jobs as defaultJobs } from '../jobs/runner';
import type { JobRunner } from '../jobs/runner';
import { createLogger } from '../log';
import { services } from '../registry/services';
import { briefSectionOf, startOfLocalDay } from './brief';
import { AUTO_PAUSE_AFTER, isTerminal, systemClock, WorkflowEngine } from './engine';
import type { EngineHooks, StepExecutor } from './engine';
import { executorFor } from './executors';
import { APPROVAL_PREFIX, postToInbox, settleInboxItem, workflowSource } from './inbox';
import { overDailyCap } from './models';
import { checkSchedule, parseSpec, validateSpec } from './spec';
import type { NodeType, WorkflowNode, WorkflowSpec } from './spec';
import { createEngineStore, deleteWorkflow, newWorkflowRecord, pruneRuns, runsOf } from './store';
import { templateSpec } from './templates';
import type { TemplateId } from './templates';

/**
 * Workflows in the extension: drafts and their confirmation, the schedule of each active workflow (one
 * job, key "workflow:<id>"), runs started by hand, by chat, by voice or by the schedule, approvals, and
 * what happens after a run (Inbox alerts, the morning brief, pausing a workflow that keeps failing).
 */

const logger = createLogger('Workflows');

export const SCHEDULE_JOB = 'workflow';
export const RUN_JOB = 'workflow-run';
// A missed time is still run if the browser starts within this; later, it waits for the next time
const CATCH_UP_MS = 2 * 60 * 60_000;
const KEEP_ALIVE_MS = 20_000;

export const scheduleKey = (workflowId: string) => `workflow:${workflowId}`;
export const runKey = (runId: string) => `workflow-run:${runId}`;

export function userTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export interface NodeEdit {
  label?: string;
  cron?: string;
  timezone?: string;
  // An llm step's instructions, a browse step's task, a search step's words
  instructions?: string;
}

function editNode(node: WorkflowNode, edit: NodeEdit): WorkflowNode {
  const next = { ...node } as WorkflowNode & Record<string, unknown>;
  if (edit.label !== undefined) next.label = edit.label;
  if (next.type === 'trigger.schedule') {
    if (edit.cron !== undefined) next.cron = edit.cron;
    if (edit.timezone !== undefined) next.timezone = edit.timezone;
  }
  if (edit.instructions !== undefined) {
    if (next.type === 'step.llm') next.instructions = edit.instructions;
    if (next.type === 'step.browse') next.task = edit.instructions;
    if (next.type === 'step.web_search') next.query = edit.instructions;
  }
  return next;
}

export class WorkflowService {
  readonly engine: WorkflowEngine;
  private readonly executing = new Map<string, AbortController>();
  private readonly firing = new Set<string>();
  private keepAlive: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly database: AviCopilotDb = defaultDb,
    private readonly jobs: JobRunner = defaultJobs,
    executors: (type: NodeType) => StepExecutor | undefined = executorFor,
  ) {
    this.engine = new WorkflowEngine(createEngineStore(database), executors, this.hooks(), systemClock);
  }

  // ── Drafts and workflows ────────────────────────────────────────────────────────────────────────

  /**
   * Saves a routine the user asked for as a draft: a new workflow, or a change waiting on an existing one.
   * Drafts never run; the user confirms them in the panel.
   */
  async saveDraft(args: {
    spec: WorkflowSpec;
    request: string;
    workflowId?: string | null;
    workspaceId?: string | null;
    agentId?: string | null;
  }): Promise<WorkflowRecord> {
    const now = Date.now();
    if (args.workflowId) {
      const workflow = await this.require(args.workflowId);
      // The diff compares with what runs now, or, for a workflow never created, with the draft it replaces
      const baseSpec = parseSpec(workflow.spec) ?? parseSpec(workflow.draft?.spec) ?? null;
      const changes: Partial<WorkflowRecord> = {
        draft: { spec: args.spec, baseSpec, request: args.request, createdAt: now },
        updatedAt: now,
        ...(workflow.status === 'draft' ? { name: args.spec.name, description: args.spec.description } : {}),
      };
      await this.database.workflows.update(workflow.id, changes);
      return { ...workflow, ...changes };
    }
    const workflow = newWorkflowRecord({
      name: args.spec.name,
      description: args.spec.description,
      workspaceId: args.workspaceId ?? null,
      agentId: args.agentId ?? null,
      draft: { spec: args.spec, baseSpec: null, request: args.request, createdAt: now },
    });
    await this.database.workflows.add(workflow);
    return workflow;
  }

  async fromTemplate(template: TemplateId, workspaceId: string | null = null): Promise<WorkflowRecord> {
    const spec = templateSpec(template, userTimezone());
    return this.saveDraft({ spec, request: spec.description, workspaceId });
  }

  /** The user's click on Create (or Apply): the draft becomes the version that runs. */
  async confirm(id: string): Promise<WorkflowRecord> {
    const workflow = await this.require(id);
    if (!workflow.draft) throw new AppError('invalid', 'There is no draft to confirm.');
    const check = validateSpec(workflow.draft.spec);
    if (!check.ok) throw new AppError('invalid', check.issues[0].message);
    const changes: Partial<WorkflowRecord> = {
      spec: check.spec,
      version: workflow.version + 1,
      draft: null,
      name: check.spec.name,
      description: check.spec.description,
      status: workflow.status === 'draft' ? 'active' : workflow.status,
      failuresInRow: 0,
      updatedAt: Date.now(),
    };
    await this.database.workflows.update(id, changes);
    const updated = { ...workflow, ...changes };
    await this.syncSchedule(updated, true);
    return updated;
  }

  /** Drops the draft; a workflow that was never created goes with it. */
  async discard(id: string): Promise<void> {
    const workflow = await this.require(id);
    if (workflow.status === 'draft') {
      await deleteWorkflow(this.database, id);
      return;
    }
    await this.database.workflows.update(id, { draft: null, updatedAt: Date.now() });
  }

  async rename(id: string, name: string): Promise<void> {
    const workflow = await this.require(id);
    const rename = (spec: WorkflowSpec | null) => (spec ? { ...spec, name } : spec);
    await this.database.workflows.update(id, {
      name,
      spec: rename(parseSpec(workflow.spec)),
      ...(workflow.draft ? { draft: { ...workflow.draft, spec: rename(parseSpec(workflow.draft.spec)) } } : {}),
      updatedAt: Date.now(),
    });
  }

  /**
   * A change made by hand in the panel: a node's name, a schedule, an instruction. It applies to the draft
   * when there is one, else to the version that runs (the user's own click, checked like any change).
   */
  async editNode(id: string, nodeId: string, edit: NodeEdit): Promise<WorkflowRecord> {
    const workflow = await this.require(id);
    const onDraft = Boolean(workflow.draft);
    const current = parseSpec(onDraft ? workflow.draft!.spec : workflow.spec);
    if (!current || !current.nodes.some(node => node.id === nodeId)) {
      throw new AppError('not_found', 'That step is not in this workflow.');
    }
    const next = { ...current, nodes: current.nodes.map(node => (node.id === nodeId ? editNode(node, edit) : node)) };
    const check = validateSpec(next);
    if (!check.ok) throw new AppError('invalid', check.issues[0].message);
    const now = Date.now();
    const changes: Partial<WorkflowRecord> = onDraft
      ? { draft: { ...workflow.draft!, spec: check.spec }, updatedAt: now }
      : { spec: check.spec, version: workflow.version + 1, updatedAt: now };
    await this.database.workflows.update(id, changes);
    const updated = { ...workflow, ...changes };
    if (!onDraft && (edit.cron !== undefined || edit.timezone !== undefined)) await this.syncSchedule(updated, true);
    return updated;
  }

  async setPaused(id: string, paused: boolean): Promise<WorkflowRecord> {
    const workflow = await this.require(id);
    if (workflow.status === 'draft') throw new AppError('invalid', 'Create the workflow first.');
    const changes: Partial<WorkflowRecord> = {
      status: paused ? 'paused' : 'active',
      ...(paused ? {} : { failuresInRow: 0 }),
      updatedAt: Date.now(),
    };
    await this.database.workflows.update(id, changes);
    const updated = { ...workflow, ...changes };
    await this.syncSchedule(updated, true);
    return updated;
  }

  async remove(id: string): Promise<void> {
    for (const run of await runsOf(this.database, id)) {
      if (!isTerminal(run.status)) await this.cancelRun(run.id);
    }
    await this.dropJob(scheduleKey(id));
    await deleteWorkflow(this.database, id);
  }

  // ── Runs ────────────────────────────────────────────────────────────────────────────────────────

  /** Starts a run now, for the user (Run now, chat, voice). One run of a workflow at a time. */
  async start(
    workflowId: string,
    options: { trigger: { type: string; detail: string }; attended: boolean },
  ): Promise<RunRecord> {
    const workflow = await this.require(workflowId);
    if (workflow.status === 'draft') {
      throw new AppError('invalid', `"${workflow.name}" is still a draft: click Create first. Drafts never run.`);
    }
    if (await this.openRunOf(workflowId)) throw new AppError('invalid', `"${workflow.name}" is already running.`);
    const run = await this.engine.createRun(workflow, options);
    void this.execute(run.id);
    return run;
  }

  /** Works on a run in this background, once at a time per run. */
  async execute(runId: string, outer?: AbortSignal): Promise<void> {
    if (this.executing.has(runId)) return;
    const controller = new AbortController();
    const stop = () => controller.abort();
    outer?.addEventListener('abort', stop, { once: true });
    this.executing.set(runId, controller);
    this.updateKeepAlive();
    try {
      await this.engine.execute(runId, controller.signal);
    } catch (error) {
      logger.error('A workflow run failed to run', runId, error);
    } finally {
      this.executing.delete(runId);
      this.updateKeepAlive();
      outer?.removeEventListener('abort', stop);
    }
  }

  async cancelRun(runId: string): Promise<void> {
    const controller = this.executing.get(runId);
    if (controller) {
      controller.abort();
      return;
    }
    await this.dropJob(runKey(runId));
    // A browser task the run waits on stops too
    for (const step of await this.database.runSteps.where('runId').equals(runId).toArray()) {
      const threadId = (step.state as { threadId?: string } | null)?.threadId;
      if (threadId && (step.status === 'running' || step.status === 'waiting_user')) {
        await services()
          .threads.cancel(threadId)
          .catch(() => {});
      }
    }
    await this.engine.cancel(runId);
  }

  /** The user's answer to a step that waits for their click, from the panel or the Inbox. */
  async answer(runId: string, nodeId: string, approved: boolean): Promise<boolean> {
    const run = await this.engine.answer(runId, nodeId, approved);
    if (!run) return false;
    if (run.workflowId)
      await settleInboxItem(workflowSource(run.workflowId), `${runId}:${nodeId}:approval`, this.database);
    void this.execute(runId);
    return true;
  }

  /** The Inbox's way in: an approval's request id, "workflow-step:<runId>:<nodeId>". */
  async answerRequest(requestId: string, approved: boolean): Promise<boolean> {
    if (!requestId.startsWith(APPROVAL_PREFIX)) return false;
    const [runId, nodeId] = requestId.slice(APPROVAL_PREFIX.length).split(':');
    return runId && nodeId ? this.answer(runId, nodeId, approved) : false;
  }

  /** Job handler: a workflow's schedule fired. One firing makes one run, even when the job runs twice. */
  async fire(job: JobRecord, signal: AbortSignal): Promise<void> {
    const workflowId = (job.payload as { workflowId?: string } | null)?.workflowId;
    const workflow = workflowId ? await this.database.workflows.get(workflowId) : undefined;
    if (!workflow || workflow.status !== 'active') return;
    const firingKey = `${workflow.id}@${job.runAt}`;
    if (this.firing.has(firingKey)) return;
    this.firing.add(firingKey);
    try {
      const runs = await runsOf(this.database, workflow.id);
      const same = runs.find(run => run.firingKey === firingKey);
      if (same) {
        if (!isTerminal(same.status)) await this.execute(same.id, signal);
        return;
      }
      if (runs.some(run => !isTerminal(run.status))) {
        logger.info(`"${workflow.name}" is still running; this time is skipped`);
        return;
      }
      const spec = parseSpec(workflow.spec);
      const today = runs.filter(run => run.trigger.type === 'schedule' && run.startedAt >= startOfLocalDay(Date.now()));
      if (spec && today.length >= spec.budget.maxRunsPerDay) {
        logger.info(`"${workflow.name}" reached its ${spec.budget.maxRunsPerDay} runs today`);
        return;
      }
      const run = await this.engine.createRun(workflow, {
        trigger: { type: 'schedule', detail: new Date(job.runAt).toISOString() },
        attended: false,
        firingKey,
      });
      await this.execute(run.id, signal);
    } catch (error) {
      // Never thrown to the job runner: it would run the whole workflow again
      logger.error('A scheduled workflow did not start', workflow.id, error);
    } finally {
      this.firing.delete(firingKey);
    }
  }

  /**
   * Something happened that event triggers listen for: each active workflow with a matching trigger starts a
   * run. Such runs are unattended and tainted (a meeting's words, a message: content from outside). Items a
   * workflow left in the Inbox never trigger one, so workflows cannot set each other off in a loop.
   */
  async fireEvent(event: 'meeting_ended' | 'inbox_item', id: string, source = ''): Promise<number> {
    if (event === 'inbox_item' && source.startsWith('workflow:')) return 0;
    let started = 0;
    for (const workflow of await this.database.workflows.where('status').equals('active').toArray()) {
      const listens = parseSpec(workflow.spec)?.nodes.some(
        node => node.type === 'trigger.event' && node.event === event && (!node.source || node.source === source),
      );
      if (!listens || (await this.openRunOf(workflow.id))) continue;
      const run = await this.engine.createRun(workflow, {
        trigger: { type: 'event', detail: `${event}:${id}` },
        attended: false,
        tainted: true,
      });
      await this.jobs.schedule({ kind: RUN_JOB, key: runKey(run.id), runAt: Date.now(), payload: { runId: run.id } });
      started += 1;
    }
    return started;
  }

  /** Job handler: a run put away (or queued after a restart) carries on. */
  async wake(job: JobRecord, signal: AbortSignal): Promise<void> {
    const runId = (job.payload as { runId?: string } | null)?.runId;
    if (runId) await this.execute(runId, signal);
  }

  /** At startup: runs cut off carry on or are closed, and every active schedule has its job. */
  async recover(): Promise<void> {
    const { resume, wake } = await this.engine.recover();
    const now = Date.now();
    for (const runId of resume)
      await this.jobs.schedule({ kind: RUN_JOB, key: runKey(runId), runAt: now, payload: { runId } });
    for (const { runId, at } of wake)
      await this.jobs.schedule({ kind: RUN_JOB, key: runKey(runId), runAt: at, payload: { runId } });
    for (const workflow of await this.database.workflows.where('status').equals('active').toArray()) {
      await this.syncSchedule(workflow, false).catch(error => logger.warning('Could not schedule', workflow.id, error));
    }
    // One-off wake-ups that are long done
    await this.database.jobs
      .where('kind')
      .equals(RUN_JOB)
      .filter(job => job.status === 'done' && now - job.updatedAt > 24 * 60 * 60_000)
      .delete();
  }

  /**
   * One job per active workflow with a schedule; none for a draft, a paused one, or one without a schedule.
   * `replace` sets the next time again (after a change); without it an existing job is kept as it is, so a
   * time missed while the browser was closed can still catch up.
   */
  async syncSchedule(workflow: WorkflowRecord, replace: boolean): Promise<void> {
    const key = scheduleKey(workflow.id);
    const trigger = parseSpec(workflow.spec)?.nodes.find(node => node.type === 'trigger.schedule');
    if (workflow.status !== 'active' || !trigger || trigger.type !== 'trigger.schedule') {
      await this.dropJob(key);
      return;
    }
    if ('error' in checkSchedule(trigger.cron, trigger.timezone, Date.now())) {
      await this.dropJob(key);
      return;
    }
    const existing = await this.database.jobs.where('key').equals(key).first();
    const same = existing && existing.cron === trigger.cron && existing.timezone === trigger.timezone;
    if (!replace && same && existing.status !== 'failed' && existing.status !== 'done') return;
    await this.jobs.schedule({
      kind: SCHEDULE_JOB,
      key,
      cron: trigger.cron,
      timezone: trigger.timezone,
      payload: { workflowId: workflow.id },
      catchUpMs: CATCH_UP_MS,
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

  private async require(id: string): Promise<WorkflowRecord> {
    const workflow = await this.database.workflows.get(id);
    if (!workflow) throw new AppError('not_found', 'That workflow does not exist any more.');
    return workflow;
  }

  private async openRunOf(workflowId: string): Promise<RunRecord | undefined> {
    return (await runsOf(this.database, workflowId)).find(run => !isTerminal(run.status));
  }

  // Removes a job without stopping one that runs now: a run under way finishes, and nothing comes after it
  private async dropJob(key: string): Promise<void> {
    await this.database.jobs.where('key').equals(key).delete();
  }

  private updateKeepAlive(): void {
    // A run in progress keeps the background awake, as running chats and jobs do
    if (this.executing.size > 0 && this.keepAlive === null) {
      this.keepAlive = setInterval(() => void chrome.runtime?.getPlatformInfo?.(), KEEP_ALIVE_MS);
    } else if (this.executing.size === 0 && this.keepAlive !== null) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  }

  private hooks(): EngineHooks {
    const database = this.database;
    const base = (workflow: WorkflowRecord, run: RunRecord) => ({
      source: workflowSource(workflow.id),
      workspaceId: workflow.workspaceId,
      agentId: workflow.agentId,
      runId: run.id,
    });
    return {
      approvalNeeded: async (run, _step, node, workflow) => {
        await postToInbox(
          {
            ...base(workflow, run),
            externalId: `${run.id}:${node.id}:approval`,
            kind: 'approval',
            title: `"${workflow.name}" wants to: ${node.label}`,
            body: `This step acts for you, so it waits for your click.${run.tainted ? ' This run read content from outside; check what it is about to do.' : ''}`,
            priority: 'high',
            approval: { requestId: `${APPROVAL_PREFIX}${run.id}:${node.id}`, action: 'workflow_step_answer' },
          },
          database,
        );
      },
      unknownOutcome: async (run, _step, node, workflow) => {
        await postToInbox(
          {
            ...base(workflow, run),
            externalId: `${run.id}:${node.id}:unknown`,
            kind: 'alert',
            title: `"${workflow.name}": "${node.label}" may or may not have happened`,
            body: 'It was cut off while it ran. Check whether it happened before you run the workflow again.',
            priority: 'high',
          },
          database,
        );
      },
      wakeAt: async (runId, at) => {
        await this.jobs.schedule({ kind: RUN_JOB, key: runKey(runId), runAt: at, payload: { runId } });
      },
      autoPaused: async (workflow, run) => {
        await this.dropJob(scheduleKey(workflow.id));
        await postToInbox(
          {
            ...base(workflow, run),
            externalId: `paused:${run.id}`,
            kind: 'alert',
            title: `Paused "${workflow.name}"`,
            body: `It failed ${AUTO_PAUSE_AFTER} times in a row. The last error: ${run.error?.message ?? 'unknown'}. Fix it and resume it in Workflows.`,
            priority: 'high',
          },
          database,
        );
      },
      finished: async (run, workflow) => {
        await this.afterRun(run, workflow);
      },
      overBudget: overDailyCap,
    };
  }

  /** After a run: questions it left are settled, the brief gets its sections, and failures are told. */
  private async afterRun(run: RunRecord, workflow: WorkflowRecord | undefined): Promise<void> {
    const steps = await this.database.runSteps.where('runId').equals(run.id).toArray();
    if (workflow) {
      for (const step of steps.filter(item => item.approval === 'pending')) {
        await settleInboxItem(workflowSource(workflow.id), `${run.id}:${step.nodeId}:approval`, this.database);
      }
    }
    const sections = steps.flatMap(step => {
      const section = step.status === 'succeeded' ? briefSectionOf(step.output) : null;
      return section ? [section] : [];
    });
    if (sections.length) {
      try {
        // Added to today's brief when it is made already; else the brief, due or not, takes them in
        for (const section of sections) await services().brief.addSection(section);
        await services().brief.check();
      } catch (error) {
        logger.warning('Could not add the workflow to the morning brief', error);
      }
    }
    if (workflow && !run.attended && (run.status === 'failed' || run.status === 'interrupted')) {
      await postToInbox(
        {
          source: workflowSource(workflow.id),
          externalId: `ended:${run.id}`,
          kind: 'alert',
          title: `"${workflow.name}" ${run.status === 'failed' ? 'failed' : 'was interrupted'}`,
          body: run.error?.message ?? '',
          priority: 'normal',
          workspaceId: workflow.workspaceId,
          agentId: workflow.agentId,
          runId: run.id,
        },
        this.database,
      );
    }
    if (run.workflowId) await pruneRuns(this.database, run.workflowId);
  }
}
