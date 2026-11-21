// The growth team's approvals, ledger and requests (docs/growth-team.md, Part 9): the three agent tools, the
// Inbox answers (one item, or a whole batch), and what the workspace screen asks for (the budget and the beta
// places as the ledger has them).
import { z } from 'zod';
import { toAppError } from '@extension/shared';
import { db, productStore, teamStore } from '@extension/storage';
import { Action } from '../agent/actions/builder';
import { registerApprovalHandler } from '../inbox/approvals';
import { createLogger } from '../log';
import { answerOneOff, registerAgentAction, registerCommand, registerRecovery } from '../registry';
import {
  queueForApprovalAction,
  queueForApprovalSchema,
  requestSpendAction,
  requestSpendSchema,
  requestToolAction,
  requestToolSchema,
  TEAM_PROMPT,
} from './actions';
import { remoteBeta } from './beta';
import {
  addChannelAction,
  addChannelSchema,
  channelTestAgreed,
  draftFollowUpAction,
  draftFollowUpSchema,
  draftOutreachAction,
  draftOutreachSchema,
  MARKETING_PROMPT,
  proposeChannelTestAction,
  proposeChannelTestSchema,
  rankChannelsAction,
  rankChannelsSchema,
  stopContactAction,
  stopContactSchema,
} from './marketing/actions';
import type { MarketingDeps } from './marketing/actions';
import { postResultsAction, postResultsSchema, SOCIAL_PROMPT, socialDraftCheck } from './social/actions';
import {
  readFeedbackAction,
  readFeedbackSchema,
  requestBetaGrantAction,
  requestBetaGrantSchema,
  sortFeedbackAction,
  sortFeedbackSchema,
  LEAD_PROMPT,
} from './lead/actions';
import type { LeadDeps } from './lead/feedback';
import { channelSignals } from './lead/signals';
import { jobs, registerJobHandler } from '../jobs/runner';
import { budgetState, grantsInWeek } from './ledger';
import {
  answerBatch,
  answerItem,
  BATCH_PREFIX,
  ITEM_PREFIX,
  recoverAgreed,
  registerAgreedHook,
  registerProposalCheck,
} from './queue';
import type { QueueDeps } from './queue';

const logger = createLogger('GrowthTeam');

// What the queue asks the outside world: only the product's own count of beta places
export const QUEUE_DEPS: QueueDeps = { remoteGrants: profile => remoteBeta(profile) };

registerAgentAction({
  prompt: TEAM_PROMPT,
  create: context =>
    new Action(
      (input: z.infer<typeof queueForApprovalSchema.schema>) => queueForApprovalAction(context, input, QUEUE_DEPS),
      queueForApprovalSchema,
    ),
});
registerAgentAction({
  create: context =>
    new Action(
      (input: z.infer<typeof requestSpendSchema.schema>) => requestSpendAction(context, input, QUEUE_DEPS),
      requestSpendSchema,
    ),
});
registerAgentAction({
  create: context =>
    new Action(
      (input: z.infer<typeof requestToolSchema.schema>) => requestToolAction(context, input, QUEUE_DEPS),
      requestToolSchema,
    ),
});

// ── The Growth Lead (#74) ─────────────────────────────────────────────────────────────────────────

// The bus is reached when first needed, so this file does not load the agent machinery at startup
async function publishOnBus(topic: string, payload: unknown, options: { fromAgentId: string | null; id: string }) {
  const { agentService } = await import('../agents/instance');
  await agentService.bus.publish(topic, payload, { ...options, runId: null, tainted: true });
}

export const LEAD_DEPS: LeadDeps = { ...QUEUE_DEPS, publish: publishOnBus };

registerAgentAction({
  prompt: LEAD_PROMPT,
  create: context =>
    new Action(
      (input: z.infer<typeof readFeedbackSchema.schema>) => readFeedbackAction(context, input, LEAD_DEPS),
      readFeedbackSchema,
    ),
});
registerAgentAction({
  create: context =>
    new Action(
      (input: z.infer<typeof sortFeedbackSchema.schema>) => sortFeedbackAction(context, input, LEAD_DEPS),
      sortFeedbackSchema,
    ),
});
registerAgentAction({
  create: context =>
    new Action(
      (input: z.infer<typeof requestBetaGrantSchema.schema>) => requestBetaGrantAction(context, input, LEAD_DEPS),
      requestBetaGrantSchema,
    ),
});

// ── The Product Marketing Manager (#75) ───────────────────────────────────────────────────────────

const MARKETING_DEPS: MarketingDeps = QUEUE_DEPS;

registerAgentAction({
  prompt: MARKETING_PROMPT,
  create: context =>
    new Action(
      (input: z.infer<typeof addChannelSchema.schema>) => addChannelAction(context, input, MARKETING_DEPS),
      addChannelSchema,
    ),
});
registerAgentAction({
  create: context =>
    new Action(
      (input: z.infer<typeof rankChannelsSchema.schema>) => rankChannelsAction(context, input, MARKETING_DEPS),
      rankChannelsSchema,
    ),
});
registerAgentAction({
  create: context =>
    new Action(
      (input: z.infer<typeof proposeChannelTestSchema.schema>) =>
        proposeChannelTestAction(context, input, MARKETING_DEPS),
      proposeChannelTestSchema,
    ),
});
registerAgentAction({
  create: context =>
    new Action(
      (input: z.infer<typeof draftOutreachSchema.schema>) => draftOutreachAction(context, input, MARKETING_DEPS),
      draftOutreachSchema,
    ),
});
registerAgentAction({
  create: context =>
    new Action(
      (input: z.infer<typeof draftFollowUpSchema.schema>) => draftFollowUpAction(context, input, MARKETING_DEPS),
      draftFollowUpSchema,
    ),
});
registerAgentAction({
  create: context =>
    new Action(
      (input: z.infer<typeof stopContactSchema.schema>) => stopContactAction(context, input, MARKETING_DEPS),
      stopContactSchema,
    ),
});
// The user's yes to a channel test starts its week (Ava's own list; nothing goes out)
registerAgreedHook('new_channel', item => channelTestAgreed(item));

// ── The Product Social Manager (#76) ──────────────────────────────────────────────────────────────

registerAgentAction({
  prompt: SOCIAL_PROMPT,
  create: context =>
    new Action(
      (input: z.infer<typeof postResultsSchema.schema>) => postResultsAction(context, input),
      postResultsSchema,
    ),
});
// Every agent's draft for other people: no number code does not hold, no quote
registerProposalCheck((proposal, profile, now) => socialDraftCheck(proposal, profile, now));

// Every morning, after the night's numbers are in: a channel whose sign-ups moved goes on the bus as
// `growth.signal`, for each workspace whose Growth Lead is switched on. Plain code, no model.
const SIGNALS_JOB = 'growth-signals';
const SIGNALS_CRON = '40 7 * * *';

export async function postSignals(now = Date.now()): Promise<number> {
  const leads = await db.agents
    .filter(agent => agent.template === 'growth_lead' && agent.enabled && agent.status !== 'draft')
    .toArray();
  let posted = 0;
  for (const lead of leads) {
    if (!lead.workspaceId) continue;
    for (const signal of await channelSignals(lead.workspaceId, now)) {
      await publishOnBus('growth.signal', signal, {
        fromAgentId: lead.id,
        id: `signal:${signal.workspaceId}:${signal.day}:${signal.channel}`,
      });
      posted += 1;
    }
  }
  return posted;
}

registerJobHandler(SIGNALS_JOB, async () => {
  const posted = await postSignals();
  if (posted) logger.info(`Posted ${posted} growth signal(s)`);
});

// The user's click in the Inbox. Only this, and a rule the user saved, ever carries an item out.
registerApprovalHandler(ITEM_PREFIX, async (requestId, approved, options) => {
  const item = await answerItem(requestId.slice(ITEM_PREFIX.length), approved, { always: options?.always }, QUEUE_DEPS);
  return item !== null;
});
// False when the batch changed after its row was drawn: the Inbox then says it could not be answered, and the
// redrawn row is the one to tap
registerApprovalHandler(BATCH_PREFIX, async (requestId, approved) => {
  const answered = await answerBatch(requestId.slice(BATCH_PREFIX.length), approved, QUEUE_DEPS);
  return answered !== null;
});

// A yes to a spend or a grant that the background stopped before writing down
registerRecovery('growth-team', async () => {
  // Scheduled once, as the collector is: scheduling on every start would push a due run to tomorrow
  const existing = await db.jobs.where('key').equals(SIGNALS_JOB).first();
  if (!existing || existing.cron !== SIGNALS_CRON || existing.status === 'failed') {
    await jobs.schedule({ kind: SIGNALS_JOB, key: SIGNALS_JOB, cron: SIGNALS_CRON, catchUpMs: 2 * 60 * 60 * 1000 });
  }
  const recovered = await recoverAgreed(QUEUE_DEPS);
  if (recovered) logger.info(`Carried out ${recovered} agreed item(s) left unfinished`);
});

// ── What the workspace screen asks for ────────────────────────────────────────────────────────────

/** The budget and the beta places of a product, as the ledger has them now. */
export async function ledgerStatus(workspaceId: string, now = Date.now()) {
  const profile = await productStore.forWorkspace(workspaceId);
  const entries = await teamStore.ledger(workspaceId);
  const items = await teamStore.forWorkspace(workspaceId);
  return {
    budget: budgetState(profile?.budget ?? null, entries),
    betaRule: profile?.betaRule ?? null,
    betaUsed: grantsInWeek(entries, now),
    waiting: items.filter(item => item.status === 'queued').length,
    held: items.filter(item => item.status === 'held').length,
  };
}

registerCommand('gteam_ledger', z.object({ workspaceId: z.string().min(1).max(80) }), async (input, context) => {
  try {
    context.reply({ type: 'gteam_ok', requestId: context.requestId, result: await ledgerStatus(input.workspaceId) });
  } catch (error) {
    const appError = toAppError(error);
    logger.warning(`gteam_ledger failed (${appError.kind})`);
    context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
  }
});

// Only pages of the extension send these, never a web page and never an agent
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if (typeof message?.type !== 'string' || !message.type.startsWith('gteam_')) return;
  return answerOneOff(message, sendResponse);
});
