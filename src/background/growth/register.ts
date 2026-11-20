// Growth numbers (docs/growth-team.md, Part 7): the collector's schedule, the one notice a failed read makes,
// the agent's two tools (metrics_query, make_link), and what the workspace screen asks for (the state of a
// product's numbers, "read now", saving the product API token to the vault).
import { z } from 'zod';
import { t } from '@extension/i18n';
import { AppError, toAppError } from '@extension/shared';
import {
  db,
  deleteSecret,
  growthStore,
  last4,
  productApiTokenPrefix,
  productApiTokenRef,
  productStore,
  putSecret,
  secretVault,
  utcDay,
} from '@extension/storage';
import type { NoReadingReason, ProductProfile } from '@extension/storage';
import { Action } from '../agent/actions/builder';
import { addInboxItem } from '../inbox/store';
import { jobs, registerJobHandler } from '../jobs/runner';
import { createLogger } from '../log';
import { answerOneOff, registerAgentAction, registerCommand, registerRecovery } from '../registry';
import {
  GROWTH_PROMPT,
  makeLinkAction,
  makeLinkActionSchema,
  metricsQueryAction,
  metricsQueryActionSchema,
} from './actions';
import { collectProduct, markNoticed } from './collect';
import type { CollectOutcome } from './collect';
import { queryMetric } from './query';
import { safeApiBase } from './suture';

const logger = createLogger('Growth');

export const COLLECT_JOB = 'growth_collect';
// Every two hours, at twenty past: the product pulse (08:30 and 16:00) finds numbers at most two hours old
const COLLECT_CRON = '20 */2 * * *';

const REASON_KEYS: Record<NoReadingReason, string> = {
  not_set: 'growth_reason_not_set',
  no_token: 'growth_reason_no_token',
  agent_api_off: 'growth_reason_agent_api_off',
  unauthorized: 'growth_reason_unauthorized',
  unreachable: 'growth_reason_unreachable',
  unexpected_shape: 'growth_reason_unexpected_shape',
  not_available: 'growth_reason_not_available',
  failed: 'growth_reason_failed',
  no_collector: 'growth_reason_no_collector',
};

/** Why a product's numbers are not there, in the user's language. */
export const reasonText = (reason: NoReadingReason | null): string =>
  t((reason ? REASON_KEYS[reason] : 'growth_reason_failed') as Parameters<typeof t>[0]);

/** One Inbox item for one failure: the same reason on the same day never makes a second. */
async function tell(profile: ProductProfile, outcome: CollectOutcome): Promise<void> {
  if (!outcome.notice) return;
  await addInboxItem({
    source: 'system',
    externalId: `growth:${profile.workspaceId}:${outcome.source}:${outcome.notice.reason}:${utcDay(Date.now())}`,
    kind: 'alert',
    title: t('growth_notice_title', [profile.name || profile.workspaceId]),
    body: `${reasonText(outcome.notice.reason)}\n${t('growth_notice_noZero')}`,
    priority: 'normal',
    workspaceId: profile.workspaceId,
  });
  // Only now is it told: had the Inbox refused the item, the next run would try again
  await markNoticed(profile.workspaceId, outcome.source, outcome.notice.reason);
}

/** Every token this workspace's product API has in the vault, whatever host each was saved for. */
async function tokenRefs(id: string): Promise<string[]> {
  const prefix = productApiTokenPrefix(id);
  return (await secretVault.refs()).filter(ref => ref.startsWith(prefix));
}

/** Reads every product that has an API to read. One product failing never stops the others. */
export async function collectAll(only?: string): Promise<CollectOutcome[]> {
  const outcomes: CollectOutcome[] = [];
  const products = Object.values(await productStore.all());
  for (const profile of products) {
    if (only && profile.workspaceId !== only) continue;
    try {
      const outcome = await collectProduct(profile);
      if (!outcome) continue;
      outcomes.push(outcome);
      await tell(profile, outcome);
    } catch (error) {
      logger.warning(`Collecting ${profile.workspaceId} failed (${toAppError(error).kind})`);
    }
  }
  return outcomes;
}

registerJobHandler(COLLECT_JOB, async () => {
  await collectAll();
});

registerRecovery('growth', async () => {
  // Scheduled once: scheduling again on every start of the background would push a run that is due to the
  // next slot, and a run missed while the browser was closed would never happen
  const existing = await db.jobs.where('key').equals(COLLECT_JOB).first();
  if (!existing || existing.cron !== COLLECT_CRON || existing.status === 'failed') {
    await jobs.schedule({ kind: COLLECT_JOB, key: COLLECT_JOB, cron: COLLECT_CRON, catchUpMs: 2 * 60 * 60 * 1000 });
  }
});

registerAgentAction({
  prompt: GROWTH_PROMPT,
  create: context =>
    new Action(
      (input: z.infer<typeof metricsQueryActionSchema.schema>) => metricsQueryAction(context, input),
      metricsQueryActionSchema,
    ),
});
registerAgentAction({
  create: context =>
    new Action(
      (input: z.infer<typeof makeLinkActionSchema.schema>) => makeLinkAction(context, input),
      makeLinkActionSchema,
    ),
});

// ── What the workspace screen asks for ────────────────────────────────────────────────────────────

const workspaceId = z.string().min(1).max(80);

/** A product's numbers as the workspace screen shows them: connected or not and why, and today's sign-ups. */
async function statusOf(id: string) {
  const profile = await productStore.forWorkspace(id);
  const state = await growthStore.sourceState(id, 'product');
  const today = utcDay(Date.now());
  const signups = await queryMetric(growthStore, { productId: id, metric: 'signups', from: today, to: today });
  // The token saved for the address the product has now; one saved for another address does not count
  const tail = profile?.agentApi?.baseUrl
    ? await last4(productApiTokenRef(id, profile.agentApi.baseUrl)).catch(() => null)
    : null;
  return {
    hasApi: !!profile?.agentApi?.baseUrl,
    // Only whether a token is saved and its last characters: the token itself never leaves the vault
    hasToken: tail !== null && tail !== undefined,
    tokenTail: tail ?? '',
    status: state?.status ?? null,
    reason: state?.reason ?? null,
    reasonText: state?.reason ? reasonText(state.reason) : '',
    checkedAt: state?.checkedAt ?? null,
    lastOkAt: state?.lastOkAt ?? null,
    signupsToday: signups.total,
  };
}

function command<S extends z.ZodType>(type: string, schema: S, run: (input: z.infer<S>) => Promise<unknown>): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      context.reply({ type: 'growth_ok', requestId: context.requestId, result: await run(input) });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
    }
  });
}

command('growth_status', z.object({ workspaceId }), input => statusOf(input.workspaceId));
command('growth_collect', z.object({ workspaceId }), async input => {
  await collectAll(input.workspaceId);
  return statusOf(input.workspaceId);
});
// The user's own paste, from the workspace screen: into the vault and nowhere else. An empty one removes it.
command('growth_set_token', z.object({ workspaceId, token: z.string().max(400) }), async input => {
  const profile = await productStore.forWorkspace(input.workspaceId);
  const baseUrl = profile?.agentApi?.baseUrl ?? '';
  const token = input.token.trim();
  // One token per product: what was saved for an earlier address goes when a new one is saved or it is removed
  for (const ref of await tokenRefs(input.workspaceId)) await deleteSecret(ref);
  if (token) {
    if (!safeApiBase(baseUrl)) throw new AppError('invalid', reasonText('not_set'), { retryable: false });
    await putSecret(productApiTokenRef(input.workspaceId, baseUrl), token);
  }
  return statusOf(input.workspaceId);
});

// The workspace was deleted: its numbers, its links and its token go with it
command('growth_forget', z.object({ workspaceId }), async input => {
  await growthStore.forget(input.workspaceId);
  for (const ref of await tokenRefs(input.workspaceId)) await deleteSecret(ref);
  return null;
});

// Only pages of the extension send these, never a web page and never an agent
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if (typeof message?.type !== 'string' || !message.type.startsWith('growth_')) return;
  return answerOneOff(message, sendResponse);
});
