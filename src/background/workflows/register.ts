// The workflows stream registers its commands, jobs, agent actions, voice tools and recovery here
// (see ../registry and ../jobs/runner).
import { z } from 'zod';
import { db } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { registerJobHandler } from '../jobs/runner';
import { createLogger } from '../log';
import { dispatchCommand, registerCommand, registerRecovery } from '../registry';
import { registerWorkflowActions } from './actions';
import { workflowService } from './instance';
import { RUN_JOB, SCHEDULE_JOB } from './service';
import { TEMPLATE_IDS } from './templates';
import { registerWorkflowVoiceTools } from './voice';
import { registerStepExecutor } from './executors';
import { meetingJoinExecutor } from './meeting-join';
import { parseSpec } from './spec';
import { services } from '../registry/services';

const logger = createLogger('Workflows');
const service = workflowService;

const id = z.string().min(1).max(100);
const nodeId = z.string().min(1).max(40);

/** A panel command: its result is the reply, and a failure a plain sentence the panel can show. */
function command<S extends z.ZodType>(
  type: string,
  schema: S,
  run: (input: z.infer<S>) => Promise<Record<string, unknown> | void>,
): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      const result = (await run(input)) ?? {};
      context.reply({ type: 'workflow_ok', requestId: context.requestId, ...result });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
    }
  });
}

command('workflow_template', z.object({ template: z.enum(TEMPLATE_IDS) }), async ({ template }) => {
  const workflow = await service.fromTemplate(template);
  return { id: workflow.id };
});
command('workflow_confirm', z.object({ id }), async input => {
  const workflow = await service.confirm(input.id);
  return { id: workflow.id, version: workflow.version };
});
command('workflow_discard', z.object({ id }), input => service.discard(input.id));
command('workflow_run', z.object({ id }), async input => {
  const run = await service.start(input.id, { trigger: { type: 'manual', detail: 'panel' }, attended: true });
  return { runId: run.id };
});
command('workflow_cancel_run', z.object({ runId: id }), input => service.cancelRun(input.runId));
command('workflow_pause', z.object({ id, paused: z.boolean() }), async input => {
  await service.setPaused(input.id, input.paused);
});
command('workflow_delete', z.object({ id }), input => service.remove(input.id));
command('workflow_rename', z.object({ id, name: z.string().trim().min(1).max(80) }), input =>
  service.rename(input.id, input.name),
);
command(
  'workflow_edit_node',
  z.object({
    id,
    nodeId,
    label: z.string().trim().min(1).max(80).optional(),
    cron: z.string().trim().min(9).max(120).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    instructions: z.string().trim().min(1).max(4000).optional(),
  }),
  async ({ id: workflowId, nodeId: node, ...edit }) => {
    await service.editNode(workflowId, node, edit);
  },
);
command('workflow_step_answer', z.object({ runId: id, nodeId, approved: z.boolean() }), async input => {
  if (!(await service.answer(input.runId, input.nodeId, input.approved))) {
    throw new Error('That step is not waiting for an answer any more.');
  }
});

registerJobHandler(SCHEDULE_JOB, (job, signal) => service.fire(job, signal));
registerJobHandler(RUN_JOB, (job, signal) => service.wake(job, signal));
registerRecovery('workflows', () => service.recover());
registerWorkflowActions(service);
registerWorkflowVoiceTools(service);

// A meeting that ends sets off the workflows listening for it
db.meetings.hook('updating', (changes: Partial<{ status: string }>, meetingId: string) => {
  if (changes.status === 'done') {
    setTimeout(() => {
      void service.fireEvent('meeting_ended', meetingId).catch(error => logger.warning('Event trigger failed', error));
    });
  }
});

// The meeting-links routine's step: joins on the user's click
registerStepExecutor('step.meeting_join', meetingJoinExecutor());

/**
 * Tab triggers: a page opening at an address a routine listens for starts it. Private windows never do. When a
 * conversation is on and the routine offers to join a meeting, Ava says so (the offer itself waits in the Inbox).
 */
const lastSeen = new Map<number, string>();
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  const url = change.url ?? (change.status === 'complete' ? tab.url : undefined);
  if (!url || tab.incognito || !/^https?:/.test(url) || lastSeen.get(tabId) === url) return;
  lastSeen.set(tabId, url);
  void service
    .fireTab(tabId, url)
    .then(async started => {
      const offers = started.filter(workflow =>
        parseSpec(workflow.spec)?.nodes.some(node => node.type === 'step.meeting_join'),
      );
      if (!offers.length) return;
      const host = new URL(url).hostname.replace(/^www\./, '');
      await services()
        .voice.announce(
          `A meeting page opened (${host}). Joining and taking notes waits for their click on Allow in the Inbox.`,
        )
        .catch(() => {});
    })
    .catch(error => logger.warning('Tab trigger failed', error));
});
chrome.tabs.onRemoved.addListener(tabId => lastSeen.delete(tabId));

// The full-tab workflow editor talks to the background with one-off messages, through the same commands
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('workflows.html'))) return;
  if (typeof message?.type !== 'string' || !message.type.startsWith('workflow_')) return;
  const requestId = typeof message.requestId === 'string' ? message.requestId : null;
  void dispatchCommand(message, { reply: sendResponse, requestId }).then(handled => {
    if (!handled) sendResponse({ type: 'error', requestId, error: 'Unknown request.' });
  });
  return true;
});
