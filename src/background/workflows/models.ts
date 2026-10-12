import { generalSettingsStore, localDay, usageStore } from '@extension/storage';
import type { ChatModel } from '../llm/types';
import { resolveModels } from '../threads/factory';
import { isOverCap } from '../usage/budget';

/**
 * The one place workflows pick a model, so the model registry's role resolver can take over here without
 * touching the rest: 'smart' writes routines and summarises, 'fast' is for light work.
 */
export type WorkflowModelRole = 'smart' | 'fast';

export async function workflowModel(role: WorkflowModelRole, sessionId: string): Promise<ChatModel> {
  const { navigator, planner } = await resolveModels(null, { sessionId, notify: () => {} });
  return role === 'fast' ? navigator : planner;
}

/** The usage recorded so far under a session, to measure what one step spent. */
export async function usageOf(
  sessionId: string,
): Promise<{ inputTokens: number; outputTokens: number; costUsd: number }> {
  const totals = await usageStore.getSession(sessionId);
  return {
    inputTokens: totals?.inputTokens ?? 0,
    outputTokens: totals?.outputTokens ?? 0,
    costUsd: totals?.costUsd ?? 0,
  };
}

/** A sentence when today's spending reached the user's cap, else null. */
export async function overDailyCap(): Promise<string | null> {
  const { dailyCostCapUsd } = await generalSettingsStore.getSettings();
  const spent = (await usageStore.getDay(localDay())).costUsd;
  return isOverCap(spent, dailyCostCapUsd)
    ? `Today's spending cap ($${dailyCostCapUsd.toFixed(2)}) is reached; raise it in Settings to run model steps.`
    : null;
}
