import type { ConfirmRequest, MessageActor } from '@extension/storage';
import { Actors, ExecutionState } from '../agent/event/types';
import type { AgentEvent } from '../agent/event/types';
import { decodeRetryStatus } from '../retry/status';
import type { RetryStatus } from '../retry/status';

/**
 * What one agent event means for the thread: a message to keep, a change of activity, or a request
 * for the user. Mirrors what the side panel used to show, now decided in the background so that a
 * thread keeps its record while no panel is open.
 */
export interface EventEffect {
  message?: { actor: MessageActor; content: string };
  // The new activity line; '' clears it
  activity?: string;
  request?: ConfirmRequest;
  // The wait before an automatic retry; null clears it
  retrying?: RetryStatus | null;
}

export const ACTIVITY_PLANNING = 'planning';
export const ACTIVITY_NAVIGATING = 'navigating';

const keep = (actor: MessageActor, content: string): EventEffect => ({ message: { actor, content } });

export function effectOf(event: AgentEvent): EventEffect {
  const content = event.data?.details ?? '';

  switch (event.actor) {
    case Actors.SYSTEM:
      switch (event.state) {
        case ExecutionState.TASK_FAIL:
        case ExecutionState.TASK_CANCEL:
          return { ...keep('system', content), activity: '', retrying: null };
        case ExecutionState.TASK_OK:
          return { activity: '', retrying: null };
        case ExecutionState.ACT_NOTICE:
          return keep('system', content);
        case ExecutionState.ACT_RETRY:
          return { retrying: decodeRetryStatus(content) };
        default:
          return {};
      }

    case Actors.PLANNER:
      switch (event.state) {
        case ExecutionState.STEP_START:
          return { activity: ACTIVITY_PLANNING };
        case ExecutionState.STEP_OK:
        case ExecutionState.STEP_FAIL:
          return { ...keep('planner', content), activity: '' };
        default:
          return {};
      }

    case Actors.NAVIGATOR:
      switch (event.state) {
        case ExecutionState.STEP_START:
          return { activity: ACTIVITY_NAVIGATING };
        case ExecutionState.STEP_OK:
        case ExecutionState.STEP_CANCEL:
          return { activity: '' };
        case ExecutionState.STEP_FAIL:
          return { ...keep('navigator', content), activity: '' };
        case ExecutionState.ACT_START:
          // Caching findings is bookkeeping, not something the user needs to read
          return content === 'cache_content' ? {} : keep('navigator', content);
        case ExecutionState.ACT_FAIL:
        case ExecutionState.ACT_VERIFY:
        case ExecutionState.ACT_NOTICE:
          return keep('navigator', content);
        case ExecutionState.ACT_CONFIRM:
          try {
            return { request: JSON.parse(content) as ConfirmRequest };
          } catch {
            // A request that cannot be read is never approved; the task waits until it is stopped
            return {};
          }
        default:
          return {};
      }

    default:
      return {};
  }
}
