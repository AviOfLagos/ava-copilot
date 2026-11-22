import { onceStore } from '@extension/storage';
import type { AppErrorKind } from '@extension/shared';
import type { ConfirmField, ConfirmRequest } from '@extension/storage';
import { Actors, ExecutionState } from '../agent/event/types';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import type { GateAnswer } from '../gate/confirmGate';
import { beginOnce, checkOnce, stepFor } from './index';
import type { OnceInput } from './index';

/**
 * Do-once keys for the actions that start something in the background and take no approval card of their own
 * (run an agent, run a routine, hand a task to an agent). The same three steps every other path takes, in one
 * place: look for a record (`checkOnce`), ask the user when only their click may run it again, write "started"
 * (`beginOnce`) before the act, and settle it when the result is in.
 */

export type OnceContext = Pick<AgentContext, 'taskId' | 'emitEvent' | 'confirmGate' | 'controller' | 'stop'>;

// Errors that mean nothing was started, so the step may be tried again. Anything else stays at "started".
const DID_NOT_HAPPEN: ReadonlySet<AppErrorKind> = new Set([
  'auth',
  'forbidden',
  'invalid',
  'not_found',
  'rate_limit',
  'quota',
  'budget',
]);

/** Whether a failure means the step certainly did not happen (so a retry is not a repeat). */
export const didNotHappen = (kind: AppErrorKind): boolean => DID_NOT_HAPPEN.has(kind);

/** What the card shows when only the user's click may run a step again. */
export interface OnceCard {
  kind: 'send' | 'submit';
  intent: string;
  target: string;
  fields: ConfirmField[];
}

export interface OnceStart {
  /** The step went through: it is not run again by itself. */
  done: (result: string) => Promise<void>;
  /** The step certainly did not happen (nothing started): it may be tried again. */
  failed: (reason: string) => Promise<void>;
}

/**
 * Checks and claims a step before it runs.
 *
 * @returns `start` once the step may run (settle it with done / failed); otherwise `result`, what to tell the
 *   model: it already happened, it was cut off, or the user did not approve a repeat
 */
export async function guardOnce(
  context: OnceContext,
  input: OnceInput,
  card: OnceCard,
): Promise<{ start: OnceStart } | { result: ActionResult }> {
  const step = await stepFor(context, input);
  const once = await checkOnce(context, step);
  if (once.state === 'told') return { result: once.result };

  const asked = once.state === 'ask' ? once : null;
  if (asked) {
    const request: ConfirmRequest = {
      id: crypto.randomUUID(),
      taskId: context.taskId,
      mode: 'commit',
      kind: card.kind,
      intent: card.intent,
      target: card.target,
      pageTitle: '',
      pageUrl: '',
      fields: card.fields,
      context: '',
      repeat: asked.repeat,
    };
    const answer: GateAnswer = await context.confirmGate.ask(
      request,
      shown => context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_CONFIRM, JSON.stringify(shown)),
      context.controller.signal,
    );
    if (answer !== 'approved') {
      // A refusal ends the task, so the agent cannot look for another way to do the same thing
      await context.stop();
      return {
        result: new ActionResult({
          error: `The user did not approve doing "${input.label}" again. Nothing was started.`,
          includeInMemory: true,
        }),
      };
    }
  }

  const claim = await beginOnce(context, step, asked);
  if ('result' in claim) return { result: claim.result };
  const key = claim.record.key;
  return {
    start: {
      done: result => onceStore.finish(key, result),
      failed: reason => onceStore.fail(key, reason),
    },
  };
}
