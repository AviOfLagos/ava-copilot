import { z } from 'zod';
import { db, threadStore, workspaceStore } from '@extension/storage';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import type { ActionSchema } from '../agent/actions/schemas';
import { Actors, ExecutionState } from '../agent/event/types';
import { rulesMayAnswer } from '../gate/origins';
import { propose, resultText } from './queue';
import type { Proposal, QueueDeps } from './queue';
import { TOOL_RUNGS, toolRequest } from './requests';

/**
 * The three tools a growth agent has for anything that leaves its own notes (docs/growth-team.md, Part 9):
 * `queue_for_approval` for drafts and requests, `request_spend` for money, `request_tool` for a tool it lacks.
 * Each one only writes down what is wanted; the mode, the limits and the ledger are decided in ./queue, never
 * here and never by the model.
 */

const intent = z.string().default('').describe('purpose of this action');

export const queueForApprovalSchema = {
  name: 'queue_for_approval',
  description:
    'Leave a draft or a request for the user to approve: a post, a reply, an outreach email, a follow-up, a listing, or a request for a new channel, a new account or a plan change. Nothing goes out: it waits for their click in the Inbox. This is the only way anything you write reaches other people.',
  schema: z.object({
    intent,
    kind: z
      .enum(['post', 'reply', 'outreach_email', 'follow_up', 'listing', 'new_channel', 'new_account', 'plan_change'])
      .describe('what it is'),
    title: z.string().trim().min(1).max(160).describe('one line the user reads first'),
    text: z.string().trim().min(1).max(6000).describe('the draft exactly as it would go out, or what is asked for'),
    where: z.string().trim().max(200).default('').describe('where it would go: x, linkedin, reddit, a site, an inbox'),
    why: z.string().trim().max(400).default('').describe("why this: the week's experiment, or why this person"),
    names_customer: z.boolean().default(false).describe('true when the text names a customer or their company'),
  }),
} satisfies ActionSchema;

export const requestSpendSchema = {
  name: 'request_spend',
  description:
    'Ask the user to spend money from the marketing budget. You cannot pay for anything: this files the request, and the user pays or declines. All four answers are required.',
  schema: z.object({
    intent,
    amount_usd: z.number().positive().max(100_000).describe('how much, in US dollars'),
    buys: z.string().trim().min(1).max(300).describe('what exactly it buys'),
    tried_free: z.string().trim().min(1).max(600).describe('what was tried for free first, and what came of it'),
    expected: z.string().trim().min(1).max(400).describe('the result expected: which number moves, by how much'),
  }),
} satisfies ActionSchema;

export const requestToolSchema = {
  name: 'request_tool',
  description:
    'Say you need a tool you do not have. Free first, in this order: connected (already in your tools), free_api (a free API or MCP server the user would connect), browser (the site itself, in the browser), free_tier (a free plan that needs a new account), paid. Give the first rung that works.',
  schema: z.object({
    intent,
    need: z.string().trim().min(1).max(400).describe('what you need to do that you cannot do now'),
    tool: z.string().trim().min(1).max(120).describe('the tool or site'),
    rung: z.enum(TOOL_RUNGS).describe('the first rung of the ladder that works'),
    tried: z.string().trim().max(600).default('').describe('why each cheaper rung did not do'),
    steps: z
      .string()
      .trim()
      .max(1200)
      .default('')
      .describe('for the user: the exact clicks to connect it or open the account'),
    cost_usd: z.number().min(0).max(100_000).default(0).describe('for a paid tool: the price in US dollars'),
    expected: z.string().trim().max(400).default('').describe('for a paid tool: the result expected'),
  }),
} satisfies ActionSchema;

export const TEAM_PROMPT = `- queue_for_approval: anything you write for other people (a post, a reply, an outreach email, a listing) or want opened (a channel, an account) goes here and waits for the user's click. Never post, send or submit it yourself, on a page or through a connector.
- request_spend: you cannot pay for anything. Money is a request with the amount, what it buys, what was tried for free, and the result expected.
- request_tool: when you lack a tool, take the first rung that works: connected, a free API or MCP server, the site in the browser, a free tier, paid. Spending, a new channel, a new account, a plan change and anything naming a customer are always the user's own decision.`;

function fail(context: AgentContext, error: string): ActionResult {
  void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, error);
  return new ActionResult({ error, includeInMemory: true });
}

/** Who is asking: the chat's workspace and, when an agent runs it, that agent. */
export async function whoAsks(
  context: Pick<AgentContext, 'taskId'>,
): Promise<Pick<Proposal, 'workspaceId' | 'agentId' | 'agentName' | 'automated' | 'tainted'> | { error: string }> {
  const thread = await threadStore.get(context.taskId);
  const workspace = await workspaceStore.get(thread?.workspaceId);
  if (!workspace)
    return { error: 'This chat is in no workspace, so it has no product to act for. Ask the user to pick one.' };
  const agent = thread?.agentId ? await db.agents.get(thread.agentId) : undefined;
  return {
    workspaceId: workspace.id,
    agentId: agent?.id ?? null,
    agentName: agent?.name ?? 'Ava',
    // What the chat read from outside decides whether a saved rule may answer for it
    tainted: !rulesMayAnswer(thread),
    // Only the user's own words (typed, spoken, or sent from their phone) skip the draft checks
    automated:
      Boolean(agent) || (thread?.origin !== undefined && !['user', 'voice', 'whatsapp'].includes(thread.origin)),
  };
}

async function run(
  context: AgentContext,
  label: string,
  build: (
    who: Pick<Proposal, 'workspaceId' | 'agentId' | 'agentName' | 'tainted'>,
  ) => Proposal | { text: string } | { error: string },
  deps: QueueDeps = {},
): Promise<ActionResult> {
  void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, label);
  const who = await whoAsks(context);
  if ('error' in who) return fail(context, who.error);
  const built = build(who);
  if ('error' in built) return fail(context, built.error);
  if ('text' in built) {
    void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, 'No request needed');
    return new ActionResult({ extractedContent: built.text, includeInMemory: true });
  }
  const result = await propose(built, deps);
  if (result.state === 'refused') return fail(context, resultText(result));
  void context.emitEvent(
    Actors.NAVIGATOR,
    ExecutionState.ACT_OK,
    result.state === 'queued' ? 'Left for your approval' : result.state === 'exists' ? 'Already proposed' : 'Done',
  );
  return new ActionResult({ extractedContent: resultText(result), includeInMemory: true });
}

export function queueForApprovalAction(
  context: AgentContext,
  input: z.infer<typeof queueForApprovalSchema.schema>,
  deps?: QueueDeps,
): Promise<ActionResult> {
  return run(
    context,
    input.intent || 'Leaving it for your approval',
    who =>
      input.kind === 'outreach_email' || input.kind === 'follow_up'
        ? {
            // An email goes only through the tools that keep its rules: the do-not-write list, the day's limit,
            // one follow-up, and the footer
            error:
              'An email to a person is drafted with draft_outreach (a first email) or draft_follow_up (the one follow-up), which keep the rules. queue_for_approval does not take emails.',
          }
        : {
            ...who,
            action: input.kind,
            title: input.title,
            body: input.text,
            target: input.where,
            why: input.why,
            declaredNamesCustomer: input.names_customer,
          },
    deps,
  );
}

export function requestSpendAction(
  context: AgentContext,
  input: z.infer<typeof requestSpendSchema.schema>,
  deps?: QueueDeps,
): Promise<ActionResult> {
  return run(
    context,
    input.intent || 'Asking to spend',
    who => ({
      ...who,
      action: 'spend',
      title: input.buys,
      body: `Spend $${input.amount_usd.toFixed(2)} on: ${input.buys}`,
      target: '',
      why: input.expected,
      amountUsd: input.amount_usd,
      fields: { buys: input.buys, triedFree: input.tried_free, expected: input.expected },
    }),
    deps,
  );
}

export function requestToolAction(
  context: AgentContext,
  input: z.infer<typeof requestToolSchema.schema>,
  deps?: QueueDeps,
): Promise<ActionResult> {
  return run(
    context,
    input.intent || 'Asking for a tool',
    who => {
      const answer = toolRequest({
        need: input.need,
        tool: input.tool,
        rung: input.rung,
        tried: input.tried,
        steps: input.steps,
        costUsd: input.cost_usd,
        expected: input.expected,
      });
      if (answer.kind === 'refused') return { error: answer.why };
      if (answer.kind === 'use_it') return { text: answer.text };
      return { ...who, ...answer.proposal };
    },
    deps,
  );
}
