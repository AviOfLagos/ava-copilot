import { onceStore } from '@extension/storage';
import type { AgentContext } from '../agent/types';
import { beginOnce, checkOnce, stepFor } from '../once';
import type { SayOnce } from './say';

/**
 * The do-once key for words said in a call (issue #84): the same words are not said twice in a task, and not
 * right after a try that was cut off, without the user's click. The key is the task, the call's site and the
 * words, so other words in the same call are a new step.
 */
export async function sayOnce(context: Pick<AgentContext, 'taskId' | 'emitEvent'>, words: string): Promise<SayOnce> {
  const step = await stepFor(context, {
    what: 'meeting.say',
    scope: 'meet.google.com',
    label: 'say words in the Google Meet call',
    parts: [words],
  });
  const check = await checkOnce(context, step);
  if (check.state === 'told') return { told: check.result.error ?? 'It was already said in this task.' };
  const asked = check.state === 'ask' ? check : null;
  let key: string | null = null;
  return {
    repeat: asked?.repeat,
    begin: async () => {
      const claim = await beginOnce(context, step, asked);
      if ('result' in claim) return claim.result.error ?? 'It was already said in this task.';
      key = claim.record.key;
      return null;
    },
    done: async () => {
      if (key) await onceStore.finish(key, 'spoken');
    },
    failed: async reason => {
      if (key) await onceStore.fail(key, reason);
    },
  };
}
