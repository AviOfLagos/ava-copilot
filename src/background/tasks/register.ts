// The task board (docs/pm-desk.md, Part 2): the one-time backfill of the last 30 days, and the commands the panel
// sends (the background is the board's only writer). Meeting notes and graph readings reach the board through
// ./sources.ts, called where each source is saved.
import { z } from 'zod';
import { toAppError } from '@extension/shared';
import { taskStore } from '@extension/storage';
import { createLogger } from '../log';
import { answerOneOff, registerCommand, registerRecovery } from '../registry';
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

// Only pages of the extension send these, never a web page and never an agent
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if (typeof message?.type !== 'string' || !message.type.startsWith('tasks_')) return;
  return answerOneOff(message, sendResponse);
});
