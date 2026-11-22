import { t } from '@extension/i18n';
import { canAllowAlways, permissionRulesStore } from '@extension/storage';
import type { ConfirmRequest, RuleCandidate } from '@extension/storage';
import { Actors, ExecutionState } from '../agent/event/types';
import type { AgentContext } from '../agent/types';
import { createLogger } from '../log';
import type { GateAnswer } from './confirmGate';
import { ruleMayAnswer } from './taint';

const logger = createLogger('AllowRule');

/**
 * Asks the user about a request, unless they already allowed this kind of step every time. The one path for a
 * place that has its own card and no page to read a scope from (speaking in a Meet call).
 *
 * - A saved rule answers 'approved' without a card, counts as used, and says so in the chat.
 * - Otherwise the card offers "Allow every time" (only for a kind that may get a rule); an approval that came
 *   with it saves the rule.
 * - A kind that is always asked (money, deleting, access) never gets a rule, whatever a caller sends.
 * - A run that read content from outside (see ./taint) gets no rule either: no answer from one, no offer of one.
 */
export async function askOrAllowed(
  context: AgentContext,
  request: ConfirmRequest,
  candidate: RuleCandidate,
): Promise<GateAnswer> {
  // A repeat of a step (do once) is the user's call every time, so no rule answers it and none is offered
  // A run that read content from outside gets no rule, answering or offered: the card still shows
  const mayKeep = !request.repeat && canAllowAlways(candidate.kind, candidate.scope) && (await ruleMayAnswer(context));
  const rule = mayKeep ? await permissionRulesStore.find(candidate.kind, candidate.scope).catch(() => null) : null;
  if (rule) {
    await permissionRulesStore.used(rule.id).catch(() => undefined);
    await context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, t('gate_allowedByRule', [rule.label]));
    return 'approved';
  }
  const shown: ConfirmRequest = mayKeep ? { ...request, always: candidate } : request;
  const answer = await context.confirmGate.ask(
    shown,
    card => context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_CONFIRM, JSON.stringify(card)),
    context.controller.signal,
  );
  if (answer === 'approved' && shown.always && context.confirmGate.takeAlways(shown.id)) {
    await permissionRulesStore.allow(shown.always).catch(error => logger.warning('Could not save the rule', error));
  }
  return answer;
}
