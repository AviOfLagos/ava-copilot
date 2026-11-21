import { z } from 'zod';
import { productStore } from '@extension/storage';
import type { ProductProfile, TeamAction } from '@extension/storage';
import { ActionResult } from '../../agent/types';
import type { AgentContext } from '../../agent/types';
import type { ActionSchema } from '../../agent/actions/schemas';
import { Actors, ExecutionState } from '../../agent/event/types';
import { whoAsks } from '../actions';
import type { Proposal } from '../queue';
import { factRefusal, knownNumbers } from './facts';
import type { FactStore } from './facts';
import { postResults, postResultsText } from './posts';

/**
 * The Product Social Manager's tools and checks (docs/growth-team.md, Part 8). Posts and replies are drafted with
 * queue_for_approval like every other draft; this adds what each post brought, and the check that keeps every
 * agent's draft to the numbers code holds and away from quotes.
 */

export const postResultsSchema = {
  name: 'post_results',
  description:
    "What each of the product's posts brought over the last 14 days (sign-ups and the rest), from the numbers code collects, for links made with make_link. Read it before planning the next posts: do more of what worked.",
  schema: z.object({ intent: z.string().default('').describe('purpose of this action') }),
} satisfies ActionSchema;

export const SOCIAL_PROMPT = `- post_results: what each post brought; plan from it. A draft may state a number only when metrics_query or the product profile holds it, and never quotes anyone: code refuses it otherwise.`;

// What other people read from an agent: the drafts the fact check covers. A customer issue repeats what the
// customer reported, numbers included, and is for the team only
const CHECKED: ReadonlySet<TeamAction> = new Set(['post', 'reply', 'listing', 'outreach_email', 'follow_up']);

/** The queue's check on an agent's draft: no number code does not hold, and no quote. */
export async function socialDraftCheck(
  proposal: Proposal,
  profile: ProductProfile,
  now: number,
  store?: FactStore,
): Promise<string | null> {
  if (!proposal.agentId || !CHECKED.has(proposal.action)) return null;
  const text = `${proposal.title}\n${proposal.body}`;
  // The fast path: a draft with no number past ten and no quotation mark needs no lookup
  if (!/\d{2,}|["“«„]/.test(text)) return null;
  return factRefusal(text, await knownNumbers(profile, now, store));
}

export async function postResultsAction(
  context: AgentContext,
  input: z.infer<typeof postResultsSchema.schema>,
  deps: { now?: () => number; store?: FactStore } = {},
): Promise<ActionResult> {
  void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Reading what the posts brought');
  const who = await whoAsks(context);
  if ('error' in who) {
    void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, who.error);
    return new ActionResult({ error: who.error, includeInMemory: true });
  }
  const profile = await productStore.forWorkspace(who.workspaceId);
  if (!profile) {
    const error = 'This workspace has no product profile, so there are no posts to read.';
    void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, error);
    return new ActionResult({ error, includeInMemory: true });
  }
  const results = await postResults(profile, deps.now?.() ?? Date.now(), deps.store);
  void context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, `${results.length} posts`);
  return new ActionResult({ extractedContent: postResultsText(results), includeInMemory: true });
}
