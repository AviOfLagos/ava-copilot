import { t } from '@extension/i18n';
import { generalSettingsStore, localDay, usageStore } from '@extension/storage';
import type { AgentContext } from '../agent/types';
import { Actors, ExecutionState } from '../agent/event/types';

export const formatUsd = (amount: number): string => `$${amount.toFixed(2)}`;

/**
 * Whether today's spend has reached the daily cap. A cap of 0 means no cap.
 */
export function isOverCap(spentUsd: number, capUsd: number): boolean {
  return capUsd > 0 && spentUsd >= capUsd;
}

/**
 * Holds the task when the daily cost cap is reached and asks the user to raise it.
 * Continue re-checks the cap; Stop ends the task.
 *
 * @returns true when the task may make its next model call
 */
export async function ensureBudget(context: AgentContext): Promise<boolean> {
  for (;;) {
    const { dailyCostCapUsd } = await generalSettingsStore.getSettings();
    const spent = (await usageStore.getDay(localDay())).costUsd;
    if (!isOverCap(spent, dailyCostCapUsd)) {
      return true;
    }

    const answer = await context.confirmGate.ask(
      {
        id: crypto.randomUUID(),
        taskId: context.taskId,
        mode: 'needs_user',
        kind: 'cap',
        intent: '',
        target: t('usage_capReached_short'),
        pageTitle: '',
        pageUrl: '',
        fields: [],
        context: t('usage_capReached_detail', [formatUsd(spent), formatUsd(dailyCostCapUsd)]),
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
