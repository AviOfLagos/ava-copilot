import { generalSettingsStore, usageStore } from '@extension/storage';
import type { ChatModel } from '../llm/types';
import { resolveModels } from '../threads/factory';
import { isOverDailyBudget } from '../usage/budget';
import { createRoleModel } from '../models/roles';
import { lightModel } from '../models/light';

/**
 * The one place workflows pick a model, so the model registry's role resolver can take over here without
 * touching the rest: 'smart' writes routines, 'fast' is the cloud's fast model, and 'light' is light work (a
 * routine's model step): a running local model first when the user prefers it (models/light.ts).
 */
export type WorkflowModelRole = 'smart' | 'fast' | 'light';

export async function workflowModel(role: WorkflowModelRole, sessionId: string): Promise<ChatModel> {
  if (role === 'light') {
    const scope = { sessionId, notify: () => {} };
    return (await lightModel('routine', scope, async () => (await resolveModels(null, scope)).navigator)).chatModel;
  }
  try {
    // The registry's best available model for the role (local first when the cloud is down)
    return (await createRoleModel(role, { sessionId, notify: () => {} })).chatModel;
  } catch {
    // No catalog yet (first run, offline): the agent models from settings
    const { navigator, planner } = await resolveModels(null, { sessionId, notify: () => {} });
    return role === 'fast' ? navigator : planner;
  }
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
  if (!(await isOverDailyBudget())) return null;
  const { dailyCostCapUsd } = await generalSettingsStore.getSettings();
  return `Today's budget is reached (spending cap $${dailyCostCapUsd.toFixed(2)}, or the token cap for models with no known price); raise it in Settings to run model steps.`;
}
