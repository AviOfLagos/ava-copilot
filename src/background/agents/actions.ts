import { z } from 'zod';
import { configRefusal, runRefusal } from '../gate/origins';
import { db, localDay, threadStore } from '@extension/storage';
import type { AgentProfile, ThreadRecord } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { Action } from '../agent/actions/builder';
import type { ActionSchema } from '../agent/actions/schemas';
import { Actors, ExecutionState } from '../agent/event/types';
import { wrapUntrustedContent } from '../agent/messages/utils';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import { generateStructured } from '../llm/generate';
import { systemMessage, userMessage } from '../llm/messages';
import { registerAgentAction } from '../registry';
import { workflowModel } from '../workflows/models';
import { authoredAgentSchema, authorAgent } from './authoring';
import type { AuthoredAgent } from './authoring';
import { agentSpend } from './budget';
import { agentSummary, fieldsOf, isDraftAgent, userTimezone } from './profile';
import type { AgentService } from './service';
import { findAgent, isTerminalRun } from './service';

/**
 * What the browser agent can do with the user's agents from a chat: draft one from the user's words, change
 * one, run one, list them. The agent itself is written by a separate structured call, never by the browser
 * agent's own output; it is saved as a draft that only the user's click in the panel turns on. Agents and
 * routines cannot make or change agents: only a chat with the user can.
 */

// How long run_agent waits for a run to end before it says the run goes on in the agents' window
const RUN_WAIT_MS = 45_000;

const intent = z.string().default('').describe('purpose of this action');

export const createAgentSchema = {
  name: 'create_agent',
  description:
    "Draft an agent (works for the user on its own, again and again: on a schedule, when they open a page, when a message arrives) from the user's words. It is saved as a draft for the user to check and create",
  schema: z.object({
    intent,
    request: z.string().describe("the user's request in their words: what the agent does and when"),
  }),
} satisfies ActionSchema;

export const updateAgentSchema = {
  name: 'update_agent',
  description:
    "Change one of the user's agents as they ask. The change is saved as a draft for the user to check and apply",
  schema: z.object({
    intent,
    id: z.string().describe('the agent id from list_agents, or its exact name'),
    change: z.string().describe("the change in the user's words, e.g. also watch LinkedIn"),
  }),
} satisfies ActionSchema;

export const runAgentSchema = {
  name: 'run_agent',
  description: "Run one of the user's agents now, in its own window, and get what it found",
  schema: z.object({
    intent,
    id: z.string().describe('the agent id from list_agents, or its exact name'),
    task: z.string().default('').describe('a task for this run in the user\'s words, or "" for its usual job'),
  }),
} satisfies ActionSchema;

export const listAgentsSchema = {
  name: 'list_agents',
  description: "List the user's agents with their ids, status, triggers and today's spend",
  schema: z.object({ intent }),
} satisfies ActionSchema;

export const AGENT_ACTIONS_PROMPT = `- create_agent drafts an agent when the user wants open-ended browser work done for them on its own, again and again: watching pages they open, checking a site, researching on a schedule ("watch my X mentions", "every weekday morning research AI agent news"). Pass their request in their words; do not design it or browse for it yourself. For fixed steps (fetch these sources, summarise, put it in my brief) use create_workflow instead. It is only a draft: tell the user to open Agents, check it and click Create. Nothing runs before that.
- update_agent changes an agent when the user gives feedback on one; pass the change in their words. It makes a draft for them to apply.
- run_agent runs an agent now, in its own window; list_agents lists them with their ids. Use these for the user's agents instead of browsing.`;

/**
 * The chat a task runs in, or a refusal: routines and agents never change or run these, and a chat from WhatsApp
 * only runs and lists them (configuration is changed from the browser). See ../gate/origins.
 */
async function attendedThread(
  context: AgentContext,
  purpose: 'configure' | 'run' = 'run',
): Promise<{ thread: ThreadRecord | undefined } | { refused: string }> {
  const thread = await threadStore.get(context.taskId).catch(() => undefined);
  const refused = purpose === 'configure' ? configRefusal(thread, 'Agents') : runRefusal(thread, 'Agents');
  return refused ? { refused } : { thread };
}

/** The agents a chat may see: its workspace's and those in none (a chat in no workspace sees all). */
export async function visibleAgents(workspaceId: string | null): Promise<AgentProfile[]> {
  const all = await db.agents.toArray();
  return workspaceId ? all.filter(agent => !agent.workspaceId || agent.workspaceId === workspaceId) : all;
}

/** One line about an agent, for list_agents and voice. */
export async function agentLine(agent: AgentProfile): Promise<string> {
  const state = isDraftAgent(agent)
    ? 'a draft, not created yet'
    : agent.enabled
      ? 'on'
      : `paused${agent.pausedReason ? ` (${agent.pausedReason})` : ''}`;
  const last = agent.lastRunAt
    ? `; last run ${agent.lastRunStatus ?? 'ended'} ${new Date(agent.lastRunAt).toLocaleString()}`
    : '';
  const spent = await agentSpend(db, agent.id, localDay());
  const pending = agent.draft && !isDraftAgent(agent) ? '; a change waits for the user to apply' : '';
  return `- "${agent.name}" (id ${agent.id}): ${state}; ${agentSummary(agent)}${last}; spent $${spent.costUsd.toFixed(2)} today${pending}`;
}

async function authorFor(
  context: AgentContext,
  request: string,
  current: AgentProfile | null,
  workspaceId: string | null,
) {
  const chatModel = await workflowModel('smart', context.taskId);
  return authorAgent({
    request,
    current: current ? fieldsOf(current.draft?.profile ?? current) : null,
    workspaceId,
    timezone: userTimezone(),
    generate: async ({ system, user }) =>
      (
        await generateStructured<AuthoredAgent>({
          chatModel,
          messages: [systemMessage(system), userMessage(user)],
          schema: authoredAgentSchema,
          name: 'agent',
          abortSignal: context.controller.signal,
        })
      ).output,
  });
}

function fail(context: AgentContext, message: string): ActionResult {
  void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, message);
  return new ActionResult({ error: message, includeInMemory: true });
}

/** Waits a little for an agent run to end; what it answered, or where it stands. */
export async function agentRunResult(runId: string, waitMs: number): Promise<string> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const run = await db.runs.get(runId);
    if (!run) return 'The run is gone.';
    if (isTerminalRun(run.status) || run.status === 'waiting_user') {
      if (run.status === 'succeeded') {
        const steps = await db.runSteps.where('runId').equals(runId).toArray();
        const answer = String(steps.find(step => step.nodeId === 'task')?.output ?? '').trim();
        // What an agent read came from outside: data, never instructions
        return answer
          ? `It ran. What it found:\n${wrapUntrustedContent(answer.slice(0, 6000))}`
          : 'It ran and finished; it said nothing back.';
      }
      if (run.status === 'waiting_user')
        return "It waits for the user's click; they can answer from the Inbox or Agents.";
      return `It ended ${run.status}: ${run.error?.message ?? ''}`;
    }
    if (Date.now() > deadline) return 'It is still running in the agents window; the user can follow it in Agents.';
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

export function registerAgentActions(service: AgentService): void {
  registerAgentAction({
    prompt: AGENT_ACTIONS_PROMPT,
    create: context =>
      new Action(async (input: z.infer<typeof createAgentSchema.schema>) => {
        void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Drafting an agent');
        const allowed = await attendedThread(context, 'configure');
        if ('refused' in allowed) return fail(context, allowed.refused);
        try {
          const workspaceId = allowed.thread?.workspaceId ?? null;
          const result = await authorFor(context, input.request, null, workspaceId);
          if (!result.ok) return fail(context, result.error);
          const agent = await service.saveDraft({ profile: result.profile, request: input.request });
          return new ActionResult({
            extractedContent: `Drafted the agent "${agent.name}" (id ${agent.id}): it ${agentSummary(result.profile)}. It is only a draft: tell the user to open Agents from the menu, check it and click Create. Nothing runs before they do.`,
            includeInMemory: true,
          });
        } catch (error) {
          return fail(context, `Could not draft the agent: ${toAppError(error).message}`);
        }
      }, createAgentSchema),
  });

  registerAgentAction({
    create: context =>
      new Action(async (input: z.infer<typeof updateAgentSchema.schema>) => {
        void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Changing an agent');
        const allowed = await attendedThread(context, 'configure');
        if ('refused' in allowed) return fail(context, allowed.refused);
        const agent = findAgent(await visibleAgents(allowed.thread?.workspaceId ?? null), input.id);
        if (!agent) return fail(context, `There is no agent "${input.id}". Use list_agents to see them.`);
        try {
          // A change builds on the draft waiting for the user, if there is one, else on the agent as it is
          const result = await authorFor(context, input.change, agent, agent.workspaceId);
          if (!result.ok) return fail(context, result.error);
          await service.saveDraft({ agentId: agent.id, profile: result.profile, request: input.change });
          return new ActionResult({
            extractedContent: `Drafted the change to "${agent.name}": it ${agentSummary(result.profile)}. Tell the user to open it in Agents, check what changed and click ${isDraftAgent(agent) ? 'Create' : 'Apply'}.`,
            includeInMemory: true,
          });
        } catch (error) {
          return fail(context, `Could not change the agent: ${toAppError(error).message}`);
        }
      }, updateAgentSchema),
  });

  registerAgentAction({
    create: context =>
      new Action(async (input: z.infer<typeof runAgentSchema.schema>) => {
        void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Running an agent');
        const allowed = await attendedThread(context);
        if ('refused' in allowed) return fail(context, allowed.refused);
        const agent = findAgent(await visibleAgents(allowed.thread?.workspaceId ?? null), input.id);
        if (!agent) return fail(context, `There is no agent "${input.id}". Use list_agents to see them.`);
        try {
          const run = await service.requestRun(agent.id, {
            trigger: { type: 'chat', detail: context.taskId },
            attended: true,
            // A task written in the chat comes through the model, which may have read pages: outside
            // content. Without one, the run follows only the agent's own instructions, which the user approved.
            tainted: Boolean(input.task?.trim()),
            task: input.task,
          });
          return new ActionResult({
            extractedContent: `Ran "${agent.name}" in its own window. ${await agentRunResult(run.id, RUN_WAIT_MS)}`,
            includeInMemory: true,
          });
        } catch (error) {
          return fail(context, toAppError(error).message);
        }
      }, runAgentSchema),
  });

  registerAgentAction({
    create: context =>
      new Action(async () => {
        const thread = await threadStore.get(context.taskId).catch(() => undefined);
        const agents = await visibleAgents(thread?.workspaceId ?? null);
        const lines = await Promise.all(agents.map(agentLine));
        return new ActionResult({
          extractedContent: agents.length ? `The user's agents:\n${lines.join('\n')}` : 'The user has no agents yet.',
          includeInMemory: true,
        });
      }, listAgentsSchema),
  });
}
