import { z } from 'zod';
import { db, threadStore } from '@extension/storage';
import type { ThreadRecord, WorkflowRecord } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { Action } from '../agent/actions/builder';
import type { ActionSchema } from '../agent/actions/schemas';
import { Actors, ExecutionState } from '../agent/event/types';
import { wrapUntrustedContent } from '../agent/messages/utils';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import { toolCatalogueSectionFor } from '../integrations/section';
import { connectorService } from '../integrations/instance';
import { generateStructured } from '../llm/generate';
import { systemMessage, userMessage } from '../llm/messages';
import { registerAgentAction } from '../registry';
import { authoredSpecSchema, authorSpec } from './authoring';
import type { AuthoredSpec } from './authoring';
import { cronText, nodeDetail, triggerText } from './describe';
import { isTerminal } from './engine';
import { workflowModel } from './models';
import type { WorkflowService } from './service';
import { userTimezone } from './service';
import { groupOf, parseSpec } from './spec';
import type { WorkflowSpec } from './spec';
import { isMeetingLinksRequest, meetingLinks } from './templates';

/**
 * What the browser agent can do with workflows from a chat: draft one from the user's words, change one,
 * run one, list them. The routine itself is written by a separate structured call, never by the agent's
 * own output; it is saved as a draft that only the user's click in the panel turns on.
 */

// How long run_workflow waits for a run to end before it says the run goes on in the background
const RUN_WAIT_MS = 45_000;

const intent = z.string().default('').describe('purpose of this action');

export const createWorkflowSchema = {
  name: 'create_workflow',
  description:
    "Draft a routine (a workflow that runs on its own, on a schedule or an event) from the user's words. It is saved as a draft for the user to check and create",
  schema: z.object({
    intent,
    request: z.string().describe("the user's request in their words: when it runs and what it does"),
  }),
} satisfies ActionSchema;

export const updateWorkflowSchema = {
  name: 'update_workflow',
  description: 'Change a workflow as the user asks. The change is saved as a draft for the user to check and apply',
  schema: z.object({
    intent,
    id: z.string().describe('the workflow id from list_workflows, or its exact name'),
    change: z.string().describe("the change in the user's words, e.g. also add GitHub trending"),
  }),
} satisfies ActionSchema;

export const runWorkflowSchema = {
  name: 'run_workflow',
  description: 'Run a workflow now and get what it produced',
  schema: z.object({ intent, id: z.string().describe('the workflow id from list_workflows, or its exact name') }),
} satisfies ActionSchema;

export const listWorkflowsSchema = {
  name: 'list_workflows',
  description: "List the user's workflows with their ids, when they run and how the last run went",
  schema: z.object({ intent }),
} satisfies ActionSchema;

export const WORKFLOW_ACTIONS_PROMPT = `- create_workflow drafts a routine when the user wants something done on its own, on a schedule or when something happens ("every morning at 7:30 check Hacker News and put the best in my brief"). Pass their request in their words; do not design the steps or browse for it yourself. It is only a draft: tell the user to review the diagram in Workflows and click Create. Nothing runs before that.
- update_workflow changes a workflow when the user gives feedback on one ("also add GitHub trending"); pass the change in their words. It makes a draft for them to apply.
- run_workflow runs a workflow now; list_workflows lists them with their ids. Use these for the user's routines instead of browsing.`;

/** The chat a task runs in, or a refusal when it was not started by the user (a routine or an agent). */
async function attendedThread(
  context: AgentContext,
): Promise<{ thread: ThreadRecord | undefined } | { refused: string }> {
  const thread = await threadStore.get(context.taskId).catch(() => undefined);
  if (thread?.origin === 'workflow' || thread?.origin === 'agent') {
    return {
      refused: 'Workflows can only be created, changed or run from a chat with the user, not by a routine or an agent.',
    };
  }
  return { thread };
}

/** The workflows a chat may see: its workspace's and those in none (a chat in no workspace sees all). */
export async function visibleWorkflows(thread: ThreadRecord | undefined): Promise<WorkflowRecord[]> {
  const all = await db.workflows.toArray();
  const workspaceId = thread?.workspaceId ?? null;
  return workspaceId ? all.filter(item => !item.workspaceId || item.workspaceId === workspaceId) : all;
}

/** A workflow by id, or by name (exact, then partial), among those the chat may see. */
export function findWorkflow(workflows: WorkflowRecord[], key: string): WorkflowRecord | undefined {
  const wanted = key.trim().toLowerCase();
  return (
    workflows.find(item => item.id === key.trim()) ??
    workflows.find(item => item.name.toLowerCase() === wanted) ??
    workflows.find(item => item.name.toLowerCase().includes(wanted) && wanted.length >= 3)
  );
}

/** One line per step, for the agent to tell the user what the draft does. */
export function outline(spec: WorkflowSpec): string {
  const steps = spec.nodes
    .filter(node => groupOf(node.type) !== 'trigger')
    .map(node => `${node.label} (${nodeDetail(node)})`);
  return `${triggerText(spec)}: ${steps.join(' → ')}`;
}

/** One line about a workflow, for list_workflows and voice. */
export function workflowLine(workflow: WorkflowRecord): string {
  const spec = parseSpec(workflow.spec) ?? parseSpec(workflow.draft?.spec);
  const when = spec ? triggerText(spec) : 'not set';
  const state = workflow.status === 'draft' ? 'a draft, not created yet' : workflow.status;
  const last = workflow.lastRunAt
    ? `; last run ${workflow.lastRunStatus ?? 'ended'} ${new Date(workflow.lastRunAt).toLocaleString()}`
    : '';
  const pending = workflow.draft && workflow.status !== 'draft' ? '; a change waits for the user to apply' : '';
  return `- "${workflow.name}" (id ${workflow.id}): ${state}; runs ${when}${last}${pending}`;
}

async function authorFor(context: AgentContext, request: string, current: WorkflowSpec | null) {
  const chatModel = await workflowModel('smart', context.taskId);
  return authorSpec({
    request,
    current,
    timezone: userTimezone(),
    tools: await toolCatalogueSectionFor(connectorService, context),
    generate: async ({ system, user }) =>
      (
        await generateStructured<AuthoredSpec>({
          chatModel,
          messages: [systemMessage(system), userMessage(user)],
          schema: authoredSpecSchema,
          name: 'workflow',
          abortSignal: context.controller.signal,
        })
      ).output,
  });
}

function fail(context: AgentContext, message: string): ActionResult {
  void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, message);
  return new ActionResult({ error: message, includeInMemory: true });
}

/** Waits a little for a run to end; what its outputs and last thinking step produced, or where it stands. */
export async function runResult(runId: string, waitMs: number): Promise<string> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const run = await db.runs.get(runId);
    if (!run) return 'The run is gone.';
    if (isTerminal(run.status) || run.status === 'waiting_user') {
      if (run.status === 'succeeded') {
        const spec = parseSpec(run.spec);
        const steps = await db.runSteps.where('runId').equals(runId).sortBy('index');
        const outputs = steps
          .filter(
            step =>
              step.status === 'succeeded' && spec?.nodes.find(node => node.id === step.nodeId)?.type === 'step.llm',
          )
          .map(step => String(step.output ?? ''));
        const said = outputs.at(-1);
        // What a routine gathered came from outside: data, never instructions
        return said
          ? `It ran. What it produced:\n${wrapUntrustedContent(said.slice(0, 6000))}`
          : 'It ran and finished; it produced nothing to read out.';
      }
      if (run.status === 'waiting_user')
        return "It waits for the user's click on a step; they can answer in Workflows or the Inbox.";
      return `It ended ${run.status}: ${run.error?.message ?? ''}`;
    }
    if (Date.now() > deadline) return 'It is still running in the background; the user can follow it in Workflows.';
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

export function registerWorkflowActions(service: WorkflowService): void {
  registerAgentAction({
    prompt: WORKFLOW_ACTIONS_PROMPT,
    create: context =>
      new Action(async (input: z.infer<typeof createWorkflowSchema.schema>) => {
        void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Drafting a workflow');
        const allowed = await attendedThread(context);
        if ('refused' in allowed) return fail(context, allowed.refused);
        try {
          // The meeting-links routine is a template: no model call needed for it
          const result = isMeetingLinksRequest(input.request)
            ? { ok: true as const, spec: meetingLinks() }
            : await authorFor(context, input.request, null);
          if (!result.ok) return fail(context, result.error);
          const workflow = await service.saveDraft({
            spec: result.spec,
            request: input.request,
            workspaceId: allowed.thread?.workspaceId ?? null,
            agentId: null,
          });
          return new ActionResult({
            extractedContent: `Drafted the workflow "${workflow.name}" (id ${workflow.id}): ${outline(result.spec)}. It is only a draft: tell the user to open Workflows from the menu, check the diagram and click Create. Nothing runs before they do.`,
            includeInMemory: true,
          });
        } catch (error) {
          return fail(context, `Could not draft the workflow: ${toAppError(error).message}`);
        }
      }, createWorkflowSchema),
  });

  registerAgentAction({
    create: context =>
      new Action(async (input: z.infer<typeof updateWorkflowSchema.schema>) => {
        void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Changing a workflow');
        const allowed = await attendedThread(context);
        if ('refused' in allowed) return fail(context, allowed.refused);
        const workflow = findWorkflow(await visibleWorkflows(allowed.thread), input.id);
        if (!workflow) return fail(context, `There is no workflow "${input.id}". Use list_workflows to see them.`);
        // A change builds on the draft waiting for the user, if there is one, else on what runs now
        const current = parseSpec(workflow.draft?.spec) ?? parseSpec(workflow.spec);
        try {
          const result = await authorFor(context, input.change, current);
          if (!result.ok) return fail(context, result.error);
          await service.saveDraft({ workflowId: workflow.id, spec: result.spec, request: input.change });
          return new ActionResult({
            extractedContent: `Drafted the change to "${workflow.name}": ${outline(result.spec)}. Tell the user to open it in Workflows, check what changed on the diagram and click ${workflow.status === 'draft' ? 'Create' : 'Apply'}.`,
            includeInMemory: true,
          });
        } catch (error) {
          return fail(context, `Could not change the workflow: ${toAppError(error).message}`);
        }
      }, updateWorkflowSchema),
  });

  registerAgentAction({
    create: context =>
      new Action(async (input: z.infer<typeof runWorkflowSchema.schema>) => {
        void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Running a workflow');
        const allowed = await attendedThread(context);
        if ('refused' in allowed) return fail(context, allowed.refused);
        const workflow = findWorkflow(await visibleWorkflows(allowed.thread), input.id);
        if (!workflow) return fail(context, `There is no workflow "${input.id}". Use list_workflows to see them.`);
        try {
          const run = await service.start(workflow.id, {
            trigger: { type: 'chat', detail: context.taskId },
            attended: true,
          });
          return new ActionResult({
            extractedContent: `Ran "${workflow.name}". ${await runResult(run.id, RUN_WAIT_MS)}`,
            includeInMemory: true,
          });
        } catch (error) {
          return fail(context, toAppError(error).message);
        }
      }, runWorkflowSchema),
  });

  registerAgentAction({
    create: context =>
      new Action(async () => {
        const allowed = await attendedThread(context);
        const workflows = await visibleWorkflows('thread' in allowed ? allowed.thread : undefined);
        return new ActionResult({
          extractedContent: workflows.length
            ? `The user's workflows:\n${workflows.map(workflowLine).join('\n')}`
            : 'The user has no workflows yet.',
          includeInMemory: true,
        });
      }, listWorkflowsSchema),
  });
}

/** For voice: a schedule in words, for one workflow. */
export function scheduleWords(workflow: WorkflowRecord): string {
  const trigger = parseSpec(workflow.spec)?.nodes.find(node => node.type === 'trigger.schedule');
  return trigger && trigger.type === 'trigger.schedule' ? cronText(trigger.cron) : 'by hand';
}
