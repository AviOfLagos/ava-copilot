import { z } from 'zod';
import { t } from '@extension/i18n';
import { emptyProductProfile, productStore, threadStore, workspaceStore } from '@extension/storage';
import type { ConfirmField, ConfirmRequest, ProductProfile } from '@extension/storage';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import type { ActionSchema } from '../agent/actions/schemas';
import { Actors, ExecutionState } from '../agent/event/types';

/**
 * Ava's own way to change a workspace's product profile: she proposes the change, the user sees every field
 * that would change with what it says now, and nothing is saved without their click.
 *
 * Only the facts about the product can be changed this way. The limits (the marketing budget, the beta rule),
 * who the outreach comes from (the sender, the postal address), the accounts and the admin console are the
 * user's to set, in the workspace screen: an agent never proposes its own limits.
 */

const line = (max: number) => z.string().trim().max(max);
const lines = z.array(line(200)).max(12);

export const updateProductProfileActionSchema = {
  name: 'update_product_profile',
  description:
    "Change the product profile of this chat's workspace: the facts every agent takes about the product (who it is for, the problem, pricing, what is off limits). Give only the fields that change, with words the user gave you or that are on the product's own site, never a guess. The user confirms before anything is saved.",
  schema: z.object({
    intent: z.string().default('').describe('why this change, in one line'),
    name: line(80).optional(),
    url: line(200).optional().describe("the product's site"),
    one_liner: line(300).optional(),
    audience: lines.optional().describe('who it is for, most valuable first; replaces the whole list'),
    problem: line(600).optional().describe('what hurts without it'),
    alternatives: lines.optional().describe('what people use instead; replaces the whole list'),
    differentiators: lines.optional().describe('why this one, each one provable; replaces the whole list'),
    pricing: line(600).optional().describe('exactly as on the site'),
    stage: z.enum(['beta', 'live']).optional(),
    repo: line(120).optional().describe('owner/name, where issues go'),
    never: lines.optional().describe('claims and places that are off limits; replaces the whole list'),
  }),
} satisfies ActionSchema;

export const UPDATE_PRODUCT_PROFILE_PROMPT = `- update_product_profile: when the user tells you a fact about the workspace's product (who it is for, its pricing, what never to say), offer to save it. Never use it to store something you inferred or found on a site that is not the product's own.`;

type Input = z.infer<typeof updateProductProfileActionSchema.schema>;

const shown = (value: string | string[]) =>
  Array.isArray(value) ? (value.length ? value.join('; ') : 'not set') : value || 'not set';

/** The fields a proposal would change: what each says now and what it would say. */
export function profileChanges(
  profile: ProductProfile,
  input: Input,
): { next: ProductProfile; changes: { label: string; before: string; after: string }[] } {
  const next: ProductProfile = { ...profile };
  const changes: { label: string; before: string; after: string }[] = [];
  const set = <K extends keyof ProductProfile>(key: K, label: string, value: ProductProfile[K] | undefined) => {
    if (value === undefined) return;
    const before = shown(profile[key] as string | string[]);
    const after = shown(value as string | string[]);
    if (before === after) return;
    next[key] = value;
    changes.push({ label, before, after });
  };
  set('name', 'Name', input.name);
  set('url', 'Site', input.url);
  set('oneLiner', 'In one line', input.one_liner);
  set('audience', 'Who it is for', input.audience);
  set('problem', 'The problem it solves', input.problem);
  set('alternatives', 'What people use instead', input.alternatives);
  set('differentiators', 'Why this one', input.differentiators);
  set('pricing', 'Pricing', input.pricing);
  set('stage', 'Stage', input.stage);
  set('repo', 'Repo', input.repo);
  set('never', 'Never say or do', input.never);
  return { next, changes };
}

function fail(context: AgentContext, error: string): ActionResult {
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, error);
  return new ActionResult({ error, includeInMemory: true });
}

/** Handles update_product_profile: shows the change, waits for the user's click, then saves. */
export async function updateProductProfileAction(context: AgentContext, input: Input): Promise<ActionResult> {
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Changing the product profile');
  const thread = await threadStore.get(context.taskId);
  const workspace = await workspaceStore.get(thread?.workspaceId);
  if (!workspace) {
    return fail(
      context,
      'This chat is in no workspace, so there is no product profile to change. Ask the user to pick one.',
    );
  }
  const current = (await productStore.forWorkspace(workspace.id)) ?? emptyProductProfile(workspace);
  const { next, changes } = profileChanges(current, input);
  if (!changes.length) {
    const same = 'The product profile already says that. Nothing was changed.';
    context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, same);
    return new ActionResult({ extractedContent: same, includeInMemory: true });
  }

  const fields: ConfirmField[] = changes.map(change => ({
    label: change.label,
    value: `${change.after}\n(now: ${change.before})`,
  }));
  const request: ConfirmRequest = {
    id: crypto.randomUUID(),
    taskId: context.taskId,
    mode: 'commit',
    kind: 'tool',
    intent: input.intent || `Change the product profile of ${workspace.name}`,
    target: `Product profile › ${workspace.name}`,
    pageTitle: workspace.name,
    pageUrl: '',
    fields,
    context: '',
  };
  const answer = await context.confirmGate.ask(
    request,
    card => context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_CONFIRM, JSON.stringify(card)),
    context.controller.signal,
  );
  if (answer === 'cancelled') return fail(context, t('gate_userStopped'));
  if (answer !== 'approved') {
    // A refusal ends the task, so the agent cannot look for another way to save the same thing
    await context.stop();
    return fail(context, t('gate_declined'));
  }

  await productStore.save(next);
  const done = `Saved to the product profile of ${workspace.name}: ${changes.map(change => change.label).join(', ')}.`;
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, done);
  return new ActionResult({ extractedContent: done, includeInMemory: true });
}
