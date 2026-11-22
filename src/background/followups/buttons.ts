import { taskStore } from '@extension/storage';
import type { Task, TaskChanges } from '@extension/storage';
import { askedNext, snoozeNext, SNOOZE_DAYS } from './rules';

/**
 * The follow-up card's buttons (docs/pm-desk.md, Part 9.3) that change the task: Asked and Snooze. Done is the
 * board's own `tasks_set_status` (by Avi). Copy and Draft in WhatsApp change nothing. Nothing here sends anything.
 */

export interface ButtonDeps {
  tasks: { get(id: string): Promise<Task | undefined>; update(id: string, changes: TaskChanges): Promise<Task | null> };
  now: () => number;
}

const defaultDeps: ButtonDeps = { tasks: taskStore, now: () => Date.now() };

async function openTask(deps: ButtonDeps, taskId: string): Promise<Task> {
  const task = await deps.tasks.get(taskId);
  if (!task) throw new Error('That task is no longer on the board.');
  if (task.status !== 'open') throw new Error('That task is already closed.');
  return task;
}

/** "Asked": he asked them; the next follow-up is two working days on. */
export async function markAsked(taskId: string, deps: ButtonDeps = defaultDeps): Promise<Task> {
  const task = await openTask(deps, taskId);
  const now = deps.now();
  const saved = await deps.tasks.update(task.id, {
    followUp: { askedAt: now, nextAt: askedNext(now), count: (task.followUp?.count ?? 0) + 1, nextBy: 'asked' },
  });
  if (!saved) throw new Error('That task is no longer on the board.');
  return saved;
}

/** "Snooze": one, three or seven days; when he asked last stays as it was. */
export async function snooze(taskId: string, days: number, deps: ButtonDeps = defaultDeps): Promise<Task> {
  if (!(SNOOZE_DAYS as readonly number[]).includes(days)) throw new Error('Snooze for 1, 3 or 7 days.');
  const task = await openTask(deps, taskId);
  const saved = await deps.tasks.update(task.id, {
    followUp: { ...(task.followUp ?? { count: 0 }), nextAt: snoozeNext(deps.now(), days), nextBy: 'snooze' },
  });
  if (!saved) throw new Error('That task is no longer on the board.');
  return saved;
}
