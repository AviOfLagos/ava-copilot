import { z } from 'zod';
import { productStore, teamStore } from '@extension/storage';
import type { ProductProfile, TeamItem } from '@extension/storage';
import { ActionResult } from '../../agent/types';
import type { AgentContext } from '../../agent/types';
import type { ActionSchema } from '../../agent/actions/schemas';
import { Actors, ExecutionState } from '../../agent/event/types';
import { whoAsks } from '../actions';
import { propose, resultText } from '../queue';
import type { Proposal, ProposeResult, QueueDeps } from '../queue';
import { addChannel, channelKey, rankChannels, rankedText, startTest, TEST_DAYS } from './channels';
import type { ChannelStore } from './channels';
import { draftFollowUp, draftOutreach, stopContact } from './outreach';
import { rememberShown } from '../social/facts';

/**
 * The Product Marketing Manager's tools (docs/growth-team.md, Part 8). Positioning goes through
 * update_product_profile, which shows the user the change first. The channel list, its tests, outreach drafts and
 * the do-not-write list are here; the rules are code in ./channels and ./outreach.
 */

const intent = z.string().default('').describe('purpose of this action');
const email = z.string().trim().min(3).max(200);

export const addChannelSchema = {
  name: 'add_channel',
  description:
    "Put a channel on the product's channel list, or update it: where the audience already is. Name it as sign-ups name it (its utm source), say who is there, and what a week's cheap test would cost (0 when free).",
  schema: z.object({
    intent,
    channel: z.string().trim().min(1).max(40).describe('for example "reddit", "hn", "indiehackers", "x"'),
    reach: z.string().trim().min(1).max(200).describe('who is there, in a few words'),
    cost_usd: z.number().min(0).max(100_000).default(0),
  }),
} satisfies ActionSchema;

export const rankChannelsSchema = {
  name: 'rank_channels',
  description:
    'The channel list ranked by code from the sign-ups each channel brought over the last 28 days, with finished tests judged (kept or dropped) and the top three untested marked "test next". Read this before choosing what to test.',
  schema: z.object({ intent }),
} satisfies ActionSchema;

export const proposeChannelTestSchema = {
  name: 'propose_channel_test',
  description: `Ask the user to start a ${TEST_DAYS}-day test of a channel marked "test next" by rank_channels. The test starts only on their yes; posts and emails for it still go through queue_for_approval or the outreach drafts.`,
  schema: z.object({
    intent,
    channel: z.string().trim().min(1).max(40),
    plan: z
      .string()
      .trim()
      .min(1)
      .max(600)
      .describe('what you would do there for a week, cheaply, and what counts as moving'),
  }),
} satisfies ActionSchema;

export const draftOutreachSchema = {
  name: 'draft_outreach',
  description:
    'Draft a first email to one person found on a public page where the product is clearly relevant to their work. Plain text, short, says why them. Code adds the sender, the postal address, why they get it and how to opt out, and keeps the limits. Nothing is sent: it waits for the user.',
  schema: z.object({
    intent,
    email: email.describe('a work address shown on the public page'),
    source: z.string().trim().min(1).max(500).describe('the link to the public page where you found them'),
    why: z.string().trim().min(1).max(300).describe('why this person is relevant, in one line; it goes in the email'),
    subject: z.string().trim().min(1).max(140),
    body: z.string().trim().min(1).max(3000).describe('the email, plain text, without a signature'),
  }),
} satisfies ActionSchema;

export const draftFollowUpSchema = {
  name: 'draft_follow_up',
  description:
    'Draft the one follow-up a person may get, at least 3 working days after the first email. After it, outreach to them stops.',
  schema: z.object({
    intent,
    email,
    subject: z.string().trim().min(1).max(140),
    body: z.string().trim().min(1).max(2000),
  }),
} satisfies ActionSchema;

export const stopContactSchema = {
  name: 'stop_contact',
  description:
    'Put an address on the do-not-write list after a reply, an unsubscribe, a bounce or a request not to be contacted. No agent writes to it again, for any product.',
  schema: z.object({
    intent,
    email,
    why: z.enum(['replied', 'unsubscribed', 'bounced', 'asked']),
  }),
} satisfies ActionSchema;

export const MARKETING_PROMPT = `- Positioning first: who it is for, what they use instead, why this one. Propose it with update_product_profile; the user confirms.
- add_channel, rank_channels, then propose_channel_test for the channels marked "test next"; code judges each test week from the sign-ups.
- draft_outreach and draft_follow_up: one person at a time, found on a public page where the product fits their work; code adds the footer and keeps the limits. stop_contact after a reply, an unsubscribe or a bounce.`;

export interface MarketingDeps extends QueueDeps {
  channelStore?: ChannelStore;
}

function fail(context: AgentContext, error: string): ActionResult {
  void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, error);
  return new ActionResult({ error, includeInMemory: true });
}

function ok(context: AgentContext, label: string, text: string): ActionResult {
  void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, label);
  return new ActionResult({ extractedContent: text, includeInMemory: true });
}

async function productOf(
  context: AgentContext,
): Promise<
  | { who: Pick<Proposal, 'workspaceId' | 'agentId' | 'agentName' | 'tainted'>; profile: ProductProfile }
  | { error: string }
> {
  const who = await whoAsks(context);
  if ('error' in who) return who;
  const profile = await productStore.forWorkspace(who.workspaceId);
  if (!profile) return { error: 'This workspace has no product profile, so there is nothing to market.' };
  return { who, profile };
}

export async function addChannelAction(
  context: AgentContext,
  input: z.infer<typeof addChannelSchema.schema>,
  deps: MarketingDeps = {},
): Promise<ActionResult> {
  void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || `Adding ${input.channel}`);
  const found = await productOf(context);
  if ('error' in found) return fail(context, found.error);
  const added = await addChannel(
    found.profile.workspaceId,
    { key: input.channel, reach: input.reach, costUsd: input.cost_usd },
    deps.now?.() ?? Date.now(),
  );
  if (!added.ok) return fail(context, added.why);
  return ok(context, 'On the list', `${added.channel.key} is on the channel list (${added.channel.state}).`);
}

export async function rankChannelsAction(
  context: AgentContext,
  input: z.infer<typeof rankChannelsSchema.schema>,
  deps: MarketingDeps = {},
): Promise<ActionResult> {
  void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Ranking the channels');
  const found = await productOf(context);
  if ('error' in found) return fail(context, found.error);
  const now = deps.now?.() ?? Date.now();
  const ranked = await rankChannels(found.profile.workspaceId, now, deps.channelStore);
  rememberShown(
    found.profile.workspaceId,
    ranked.map(channel => channel.perWeek),
    now,
  );
  return ok(context, `${ranked.length} channels`, rankedText(ranked));
}

/** Asks for a channel's test week, only for a channel the ranking marked "test next". */
export async function proposeChannelTest(
  profile: ProductProfile,
  who: Pick<Proposal, 'workspaceId' | 'agentId' | 'agentName' | 'tainted'>,
  input: { channel: string; plan: string },
  deps: MarketingDeps = {},
): Promise<ProposeResult> {
  const now = deps.now?.() ?? Date.now();
  const key = channelKey(input.channel);
  const ranked = await rankChannels(profile.workspaceId, now, deps.channelStore);
  const channel = ranked.find(item => item.key === key);
  if (!channel)
    return { state: 'refused', why: `${key || input.channel} is not on the channel list: add_channel first.` };
  if (!channel.testNext) {
    return {
      state: 'refused',
      why: `${key} is not one of the channels to test next (it is ${channel.state}). Test the top three from rank_channels, one week each.`,
    };
  }
  // A test the user declined may be asked for again later: each ask is its own item
  const asked = (await teamStore.forWorkspace(profile.workspaceId)).filter(
    item => item.action === 'new_channel' && item.fields?.channel === key,
  );
  if (asked.some(item => item.status === 'queued')) {
    return { state: 'refused', why: `A test of ${key} already waits for the user.` };
  }
  return propose(
    {
      ...who,
      action: 'new_channel',
      title: `Test ${key} for ${TEST_DAYS} days`,
      body: input.plan,
      target: key,
      why: channel.costUsd ? `A cheap test: about $${channel.costUsd.toFixed(2)}` : 'A free test',
      onceKey: `channel-test:${key}:${asked.length}`,
      fields: { channel: key },
    },
    deps,
  );
}

export async function proposeChannelTestAction(
  context: AgentContext,
  input: z.infer<typeof proposeChannelTestSchema.schema>,
  deps: MarketingDeps = {},
): Promise<ActionResult> {
  void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || `Asking to test ${input.channel}`);
  const found = await productOf(context);
  if ('error' in found) return fail(context, found.error);
  const result = await proposeChannelTest(found.profile, found.who, input, deps);
  if (result.state === 'refused') return fail(context, resultText(result));
  return ok(context, 'Asked', resultText(result));
}

export async function draftOutreachAction(
  context: AgentContext,
  input: z.infer<typeof draftOutreachSchema.schema>,
  deps: MarketingDeps = {},
): Promise<ActionResult> {
  void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Drafting an email');
  const found = await productOf(context);
  if ('error' in found) return fail(context, found.error);
  const result = await draftOutreach(found.profile, found.who, input, deps);
  if (result.state === 'refused') return fail(context, `Refused by a rule in code: ${result.why}`);
  return ok(context, 'Drafted', `${result.text} ${resultText(result.result)}`);
}

export async function draftFollowUpAction(
  context: AgentContext,
  input: z.infer<typeof draftFollowUpSchema.schema>,
  deps: MarketingDeps = {},
): Promise<ActionResult> {
  void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Drafting a follow-up');
  const found = await productOf(context);
  if ('error' in found) return fail(context, found.error);
  const result = await draftFollowUp(found.profile, found.who, input, deps);
  if (result.state === 'refused') return fail(context, `Refused by a rule in code: ${result.why}`);
  return ok(context, 'Drafted', `${result.text} ${resultText(result.result)}`);
}

export async function stopContactAction(
  context: AgentContext,
  input: z.infer<typeof stopContactSchema.schema>,
  deps: MarketingDeps = {},
): Promise<ActionResult> {
  void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Stopping outreach');
  // Only an agent or chat working for a product keeps the list
  const found = await productOf(context);
  if ('error' in found) return fail(context, found.error);
  return ok(context, 'Stopped', await stopContact(input.email, input.why, deps.now?.() ?? Date.now()));
}

/** A yes to a channel test starts its week; any other channel request is the user's to open. */
export async function channelTestAgreed(item: TeamItem, now = Date.now()): Promise<string | null> {
  const key = item.fields?.channel;
  if (!key) return null;
  return startTest(item.workspaceId, key, now);
}
