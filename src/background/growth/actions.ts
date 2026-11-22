import { z } from 'zod';
import { growthStore, productStore, shiftDay, threadStore, utcDay, workspaceStore } from '@extension/storage';
import type { ProductProfile } from '@extension/storage';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import type { ActionSchema } from '../agent/actions/schemas';
import { Actors, ExecutionState } from '../agent/event/types';
import { wrapUntrustedContent } from '../agent/messages/utils';
import { PRODUCT_METRICS } from './collect';
import { makeLink } from './links';
import { answerText, MAX_RANGE_DAYS, queryMetric, rangeProblem } from './query';
import { rememberShown } from '../growth-team/social/facts';

/**
 * The two growth tools of the browser agent: `metrics_query`, the only way an agent reads numbers, and
 * `make_link`, the only way it makes a link to the product. Both work on the product of the chat's own
 * workspace and no other: workspaces never mix.
 */

export const metricsQueryActionSchema = {
  name: 'metrics_query',
  description: `Read a number about this workspace's product: ${PRODUCT_METRICS.join(', ')}. The numbers are collected by code from the product itself; this is the only place to take a product number from. The answer says when it was read. "No reading" or "not connected" means there is no number: say so, never 0 and never a guess. Read-only.`,
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    metric: z.string().trim().min(1).max(40).describe('which number, e.g. "signups"; "list" names the ones that exist'),
    from: z.string().default('').describe('first UTC day, YYYY-MM-DD; empty with `days` counts back from today'),
    to: z.string().default('').describe('last UTC day, YYYY-MM-DD; empty means today'),
    days: z
      .number()
      .int()
      .min(1)
      .max(MAX_RANGE_DAYS)
      .default(1)
      .describe(
        'with no `from`: how many days back from `to`, 1 = that day alone; 2 with no `to` = yesterday and today',
      ),
    by: z.enum(['day', 'channel', 'campaign']).default('day').describe('how to split the total'),
    product: z.string().default('').describe("leave empty: it is always this chat's workspace product"),
  }),
} satisfies ActionSchema;

export const makeLinkActionSchema = {
  name: 'make_link',
  description:
    "Make a link to this workspace's product for a post, a reply or an email. It adds utm_source, utm_medium and utm_campaign so sign-ups can be traced to where they came from. Every link to the product you write for others goes through this; never write the tags yourself.",
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    url: z.string().trim().min(1).max(600).describe("the page on the product's own site"),
    source: z.string().trim().min(1).max(60).describe('where the link goes: x, linkedin, reddit, email…'),
    medium: z.string().trim().min(1).max(60).describe('the kind of placement: social, email, community, listing'),
    campaign: z.string().trim().min(1).max(60).describe("what it belongs to: the week's experiment or the post"),
  }),
} satisfies ActionSchema;

export const GROWTH_PROMPT = `- metrics_query: for any number about the workspace's product (sign-ups, waitlist, feedback, orgs), ask this first. If it says "no reading" or "not connected", tell the user the number is not known and why; never state 0, an estimate or a number from a page instead.
- make_link: any link to the product that you put in a draft for other people is made with this, so it can be traced.`;

function fail(context: AgentContext, error: string): ActionResult {
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, error);
  return new ActionResult({ error, includeInMemory: true });
}

/** The product of the chat's workspace, or what to tell the model when there is none. */
async function productOf(context: AgentContext): Promise<{ profile: ProductProfile } | { error: string }> {
  const thread = await threadStore.get(context.taskId);
  const workspace = await workspaceStore.get(thread?.workspaceId);
  if (!workspace) return { error: 'This chat is in no workspace, so it has no product. Ask the user to pick one.' };
  const profile = await productStore.forWorkspace(workspace.id);
  if (!profile)
    return { error: `The workspace ${workspace.name} has no product profile yet. The user adds one in Workspaces.` };
  return { profile };
}

export async function metricsQueryAction(
  context: AgentContext,
  input: z.infer<typeof metricsQueryActionSchema.schema>,
): Promise<ActionResult> {
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || `Reading ${input.metric}`);
  const found = await productOf(context);
  if ('error' in found) return fail(context, found.error);
  const { profile } = found;
  // One workspace's chat never reads another product's numbers
  const asked = input.product.trim().toLowerCase();
  if (asked && asked !== profile.workspaceId.toLowerCase() && asked !== profile.name.trim().toLowerCase()) {
    return fail(context, `This chat can only read the numbers of ${profile.name}, the product of its own workspace.`);
  }

  const metric = input.metric.toLowerCase().replace(/[\s-]+/g, '_');
  const known = await growthStore.knownMetrics(profile.workspaceId);
  if (metric === 'list') {
    const names = known.length ? known.map(item => item.metric).join(', ') : 'none yet';
    const list = `Numbers collected for ${profile.name}: ${names}. The product collector reads: ${PRODUCT_METRICS.join(', ')}.`;
    context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, 'Listed the numbers');
    return new ActionResult({ extractedContent: list, includeInMemory: true });
  }

  const to = input.to.trim() || utcDay(Date.now());
  const from = input.from.trim() || shiftDay(to, -(input.days - 1));
  const problem = rangeProblem(from, to);
  if (problem) return fail(context, problem);

  const answer = await queryMetric(growthStore, {
    productId: profile.workspaceId,
    metric,
    from,
    to,
    by: input.by,
  });
  // A number shown to the agent is one its drafts may state (growth-team/social/facts.ts)
  rememberShown(profile.workspaceId, [
    answer.total,
    ...answer.byDay.map(day => day.value),
    ...answer.parts.map(part => part.value),
  ]);
  let text = answerText(answer, profile.name);
  if (answer.total === null && !known.some(item => item.metric === metric)) {
    text += `\nNo collector has ever read "${metric}" for ${profile.name}. Known numbers: ${known.map(item => item.metric).join(', ') || 'none yet'}.`;
  }
  context.emitEvent(
    Actors.NAVIGATOR,
    ExecutionState.ACT_OK,
    answer.total === null ? `${metric}: no reading` : `${metric}: ${answer.total}`,
  );
  // Channel and campaign names come from the product's visitors: data, never instructions
  return new ActionResult({ extractedContent: wrapUntrustedContent(text), includeInMemory: true, outside: true });
}

export async function makeLinkAction(
  context: AgentContext,
  input: z.infer<typeof makeLinkActionSchema.schema>,
): Promise<ActionResult> {
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Making a link');
  const found = await productOf(context);
  if ('error' in found) return fail(context, found.error);
  const made = makeLink(found.profile, input);
  if (!made.ok) return fail(context, made.error);
  await growthStore.addLink({
    productId: found.profile.workspaceId,
    url: made.url,
    target: made.target,
    source: made.tags.source,
    medium: made.tags.medium,
    campaign: made.tags.campaign,
    createdAt: Date.now(),
    threadId: context.taskId,
  });
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, `Link made for ${made.tags.source}`);
  return new ActionResult({
    extractedContent: `Link (use it exactly as written): ${made.url}\nTagged source=${made.tags.source}, medium=${made.tags.medium}, campaign=${made.tags.campaign}.`,
    includeInMemory: true,
  });
}
