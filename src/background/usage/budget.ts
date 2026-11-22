import { t } from '@extension/i18n';
import { generalSettingsStore, localDay, modelSettingsStore, usageStore } from '@extension/storage';
import type { AgentContext } from '../agent/types';
import { Actors, ExecutionState } from '../agent/event/types';

export const formatUsd = (amount: number): string => `$${amount.toFixed(2)}`;

export const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 1000
      ? `${Math.round(tokens / 1000)}k`
      : `${tokens}`;

/**
 * Whether today's spend has reached the daily cap. A cap of 0 means no cap.
 */
export function isOverCap(spentUsd: number, capUsd: number): boolean {
  return capUsd > 0 && spentUsd >= capUsd;
}

/** Today's spending against both caps: dollars for models with a price, tokens for models without one. */
export interface BudgetState {
  spentUsd: number;
  capUsd: number;
  unpricedTokens: number;
  tokenCap: number;
  overCost: boolean;
  overTokens: boolean;
}

export async function budgetState(day = localDay()): Promise<BudgetState> {
  const [{ dailyCostCapUsd }, { unpricedDailyTokenCap }, today] = await Promise.all([
    generalSettingsStore.getSettings(),
    modelSettingsStore.getSettings(),
    usageStore.getDay(day),
  ]);
  const unpricedTokens = today.unpricedTokens ?? 0;
  return {
    spentUsd: today.costUsd,
    capUsd: dailyCostCapUsd,
    unpricedTokens,
    tokenCap: unpricedDailyTokenCap,
    overCost: isOverCap(today.costUsd, dailyCostCapUsd),
    overTokens: isOverCap(unpricedTokens, unpricedDailyTokenCap),
  };
}

/**
 * Whether background work (routines, agents, the graph, the brief) should hold for the day: the cost cap is
 * reached, or the token cap is and models with no price are in use.
 */
export async function isOverDailyBudget(): Promise<boolean> {
  const state = await budgetState();
  return state.overCost || state.overTokens;
}

/**
 * Holds the task when a daily cap is reached and asks the user to raise it: the cost cap always, the token
 * cap for models with no known price once this chat has used one. Continue re-checks; Stop ends the task.
 *
 * @returns true when the task may make its next model call
 */
export async function ensureBudget(context: AgentContext): Promise<boolean> {
  for (;;) {
    const state = await budgetState();
    const usesUnpriced = state.overTokens && (await usageStore.getSession(context.taskId)).unpricedCalls > 0;
    if (!state.overCost && !usesUnpriced) {
      return true;
    }

    // Always asked, on purpose (issue #93): raising a spending cap is money, so this card never offers
    // "Allow every time" and `canAllowAlways` has no kind for it
    const answer = await context.confirmGate.ask(
      {
        id: crypto.randomUUID(),
        taskId: context.taskId,
        mode: 'needs_user',
        kind: 'cap',
        intent: '',
        target: state.overCost ? t('usage_capReached_short') : t('models_tokenCap_reached'),
        pageTitle: '',
        pageUrl: '',
        fields: [],
        context: state.overCost
          ? t('usage_capReached_detail', [formatUsd(state.spentUsd), formatUsd(state.capUsd)])
          : t('models_tokenCap_detail', [formatTokens(state.unpricedTokens), formatTokens(state.tokenCap)]),
      },
      request => context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_CONFIRM, JSON.stringify(request)),
      context.controller.signal,
    );
    if (answer !== 'approved') {
      await context.stop();
      return false;
    }
  }
}
