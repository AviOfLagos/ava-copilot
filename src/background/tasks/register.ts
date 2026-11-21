// The task board (docs/pm-desk.md, Part 2): the one-time backfill of the last 30 days, and the commands the panel
// sends (the background is the board's only writer). Meeting notes and graph readings reach the board through
// ./sources.ts, called where each source is saved.
import { z } from 'zod';
import { toAppError } from '@extension/shared';
import { OLD_TASK_AGE, taskStore } from '@extension/storage';
import { createLogger } from '../log';
import { answerOneOff, registerCommand, registerRecovery } from '../registry';
import { registerTaskTools } from './actions';
import { backfillOnce } from './backfill';

const logger = createLogger('Tasks');

registerRecovery('tasks', async () => {
  await backfillOnce().catch(error => logger.warning('Could not fill the task board from the last 30 days', error));
});

const taskId = z.string().min(1).max(40);

/** A panel command: its result, or the plain sentence of what went wrong. */
export function command<S extends z.ZodType>(
  type: `tasks_${string}`,
  schema: S,
  run: (input: z.infer<S>) => Promise<unknown>,
): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      context.reply({ type: 'tasks_ok', requestId: context.requestId, result: await run(input) });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
    }
  });
}

// A box ticked or unticked in the panel: by Avi, always
command('tasks_set_status', z.object({ id: taskId, status: z.enum(['open', 'done', 'dropped']) }), async input => {
  const task = await taskStore.setStatus(input.id, input.status, 'avi');
  if (!task) throw new Error('That task is no longer on the board.');
  return task;
});

// What the Tasks page sends: every change is the user's own (by 'avi')
const words = (max: number) => z.string().trim().max(max);
const workspaceId = z.string().min(1).max(80).nullable();
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .or(z.literal(''));

command(
  'tasks_add',
  z.object({ title: words(200).min(1), workspaceId, ownerName: words(80).default(''), due: isoDate.default('') }),
  input =>
    taskStore.add({
      title: input.title,
      workspaceId: input.workspaceId,
      workspaceSetBy: 'avi',
      ownerName: input.ownerName || null,
      ...(input.due ? { due: input.due } : {}),
    }),
);

command(
  'tasks_update',
  z.object({
    id: taskId,
    title: words(200).min(1).optional(),
    ownerName: words(80).optional(),
    due: isoDate.optional(),
  }),
  async input => {
    const task = await taskStore.update(input.id, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.ownerName !== undefined ? { ownerName: input.ownerName || null } : {}),
      // A date set by hand replaces the words it was worked out from
      ...(input.due !== undefined ? { due: input.due || undefined, dueText: undefined } : {}),
    });
    if (!task) throw new Error('That task is no longer on the board.');
    return task;
  },
);

command('tasks_move', z.object({ ids: z.array(taskId).min(1).max(500), workspaceId }), input =>
  taskStore.move(input.ids, input.workspaceId, 'avi'),
);

command('tasks_merge', z.object({ keepId: taskId, dropId: taskId }), async input => {
  const task = await taskStore.merge(input.keepId, input.dropId);
  if (!task) throw new Error('That task is no longer on the board.');
  return task;
});

// "Close everything older than two weeks"
command('tasks_close_old', z.object({}), () => taskStore.closeOlderThan(OLD_TASK_AGE));

registerTaskTools();

// Only pages of the extension send these, never a web page and never an agent
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if (typeof message?.type !== 'string' || !message.type.startsWith('tasks_')) return;
  return answerOneOff(message, sendResponse);
});
