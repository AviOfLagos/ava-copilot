// The growth team's approvals, ledger and requests (docs/growth-team.md, Part 9): the three agent tools, the
// Inbox answers (one item, or a whole batch), and what the workspace screen asks for (the budget and the beta
// places as the ledger has them).
import { z } from 'zod';
import { toAppError } from '@extension/shared';
import { productStore, teamStore } from '@extension/storage';
import { Action } from '../agent/actions/builder';
import { registerApprovalHandler } from '../inbox/approvals';
import { createLogger } from '../log';
import { answerOneOff, registerAgentAction, registerCommand } from '../registry';
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
import { budgetState, grantsInWeek } from './ledger';
import { answerBatch, answerItem, BATCH_PREFIX, ITEM_PREFIX } from './queue';
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

// The user's click in the Inbox. Only this, and a rule the user saved, ever carries an item out.
registerApprovalHandler(ITEM_PREFIX, async (requestId, approved, options) => {
  const item = await answerItem(requestId.slice(ITEM_PREFIX.length), approved, { always: options?.always }, QUEUE_DEPS);
  return item !== null;
});
registerApprovalHandler(BATCH_PREFIX, async (requestId, approved) => {
  await answerBatch(requestId.slice(BATCH_PREFIX.length), approved, QUEUE_DEPS);
  return true;
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
