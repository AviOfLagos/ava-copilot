// The inbox stream registers its commands, jobs, agent actions, voice tools and recovery here
// (see ../registry and ../jobs/runner).
import { z } from 'zod';
import { db } from '@extension/storage';
import type { InboxItem } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { jobs, registerJobHandler } from '../jobs/runner';
import { createLogger } from '../log';
import { registerCommand, registerRecovery } from '../registry';
import { services } from '../registry/services';
import { APPROVAL_PREFIX } from '../workflows/inbox';
import { workflowService } from '../workflows/instance';
import { announceItem, announceMeetingSoon } from './announcer';
import { answerApproval, registerApprovalHandler } from './approvals';
import { refreshBadge } from './badge';
import { RETENTION_CRON, RETENTION_JOB_KEY, WATCH_CRON, WATCH_JOB_KEY, snoozeJobKey } from './constants';
import { notifyHighPriority } from './notify';
import { markDone, markRead, markUnread, pruneDone, rescheduleSnoozes, snoozeItem, wakeSnoozed } from './store';
import { registerInboxVoiceTools } from './voice';
import { runWatchers } from './watchers';

const logger = createLogger('Inbox');

/** A panel command: its result is the reply, and a failure a plain sentence the panel can show. */
function command<S extends z.ZodType>(
  type: string,
  schema: S,
  run: (input: z.infer<S>) => Promise<Record<string, unknown> | void>,
): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      const result = (await run(input)) ?? {};
      context.reply({ type: 'inbox_ok', requestId: context.requestId, ...result });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
    }
  });
}

const id = z.string().min(1).max(300);

command('inbox_mark_read', z.object({ id }), async input => {
  await markRead(input.id);
});
command('inbox_mark_unread', z.object({ id }), async input => {
  await markUnread(input.id);
});
command('inbox_mark_done', z.object({ id }), async input => {
  await markDone(input.id);
});
command('inbox_snooze', z.object({ id, until: z.number().int().positive() }), async input => {
  await snoozeItem(input.id, input.until);
  await jobs.schedule({
    kind: 'inbox_unsnooze',
    key: snoozeJobKey(input.id),
    runAt: input.until,
    payload: { id: input.id },
  });
});
// Named approvalRequestId, not requestId: every panelApi.request() call already carries its own
// protocol-level requestId (for matching the reply), which would silently overwrite a field plainly
// called requestId in the message's own data.
command(
  'inbox_answer',
  // `always`: "Allow every time", for an item that offers it (its handler decides whether a rule may be kept)
  z.object({ approvalRequestId: z.string().min(1).max(300), approved: z.boolean(), always: z.boolean().optional() }),
  async input => {
    const handled = await answerApproval(input.approvalRequestId, input.approved, {
      always: input.approved && input.always === true,
    });
    if (!handled) throw new Error('That could not be answered any more.');
  },
);
command('inbox_watch_now', z.object({}), async () => {
  const added = await runWatchers();
  return { added };
});

// What a new item does on its own: the badge, a workflow event trigger, a throttled desktop
// notification for high priority, and a short spoken line when it is worth interrupting for. Deferred
// past the write (Dexie hooks run inside the transaction) exactly as the workflows stream's own
// meetings hook does.
async function handleNewItem(item: InboxItem): Promise<void> {
  await refreshBadge();
  await workflowService.fireEvent('inbox_item', item.id, item.source).catch(error => {
    logger.warning('An inbox event trigger failed', error);
  });
  await notifyHighPriority(item);
  await announceItem(item);
}

db.inbox.hook('creating', (_primKey, item) => {
  setTimeout(() => {
    void handleNewItem(item).catch(error => logger.warning('Inbox item follow-up failed', error));
  });
});
// A status change (read, done, snoozed, un-snoozed, an approval answered) can change the unread count
db.inbox.hook('updating', () => {
  setTimeout(() => void refreshBadge().catch(() => {}));
});
// Meetings own the badge while one records; once none does, the Inbox's own count is due back
db.meetings.hook('updating', (changes: Partial<{ status: string }>) => {
  if (changes.status && changes.status !== 'recording') {
    setTimeout(() => void refreshBadge().catch(() => {}));
  }
});

registerJobHandler('inbox_retention', async () => {
  const removed = await pruneDone();
  if (removed) logger.info(`Removed ${removed} old Inbox item(s)`);
});
registerJobHandler('inbox_watch', async () => {
  await runWatchers();
});
registerJobHandler('inbox_unsnooze', async job => {
  const itemId = (job.payload as { id?: string } | null)?.id;
  if (itemId) await wakeSnoozed(itemId);
});

registerApprovalHandler(APPROVAL_PREFIX, (requestId, approved, options) =>
  workflowService.answerRequest(requestId, approved, options),
);
registerInboxVoiceTools();

registerRecovery('inbox', async () => {
  await jobs.schedule({ kind: 'inbox_retention', key: RETENTION_JOB_KEY, cron: RETENTION_CRON });
  await jobs.schedule({ kind: 'inbox_watch', key: WATCH_JOB_KEY, cron: WATCH_CRON });
  await rescheduleSnoozes(request => jobs.schedule(request), snoozeJobKey);
  await refreshBadge();
  // A meeting about to start is said aloud when nobody else already will: index.ts's own handler
  // speaks it over a running Live conversation, so this only fills in the local-TTS fallback.
  services().calendar.onReminder(reminder => {
    void announceMeetingSoon(reminder).catch(error => logger.warning('Meeting announcement failed', error));
  });
});
