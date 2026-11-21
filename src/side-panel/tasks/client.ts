import type { TaskStatus } from '@extension/storage';

/**
 * Sends a task command to the background, which is the only writer of the board (src/background/tasks).
 * Resolves with the command's result, rejects with the background's error.
 */
export async function tasksRequest<T = unknown>(
  message: { type: `tasks_${string}` } & Record<string, unknown>,
): Promise<T> {
  const reply = (await chrome.runtime.sendMessage({ ...message, requestId: crypto.randomUUID() })) as
    { type?: string; error?: string; result?: T } | undefined;
  if (!reply) throw new Error('The background did not answer.');
  if (reply.type === 'error') throw new Error(reply.error || 'Something went wrong.');
  return reply.result as T;
}

/** Ticks or unticks a task. */
export const setTaskStatus = (id: string, status: TaskStatus) => tasksRequest({ type: 'tasks_set_status', id, status });
