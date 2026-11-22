// Follow-ups (docs/pm-desk.md, Part 9): what each person is doing, and the panel's commands. The background is the
// only writer: pages read `db.personUpdates` and `db.tasks` with live queries and send `followups_*` commands.
import { z } from 'zod';
import { toAppError } from '@extension/shared';
import { db, personUpdateStore, taskStore } from '@extension/storage';
import { createLogger } from '../log';
import { onPeopleChange } from '../people/people';
import { answerOneOff, registerCommand, registerRecovery } from '../registry';
import { jobs, registerJobHandler } from '../jobs/runner';
import { registerFollowUpTools } from './actions';
import { markAsked, snooze } from './buttons';
import { draftFor } from './draft';
import { recordReport } from './report';
import { postFollowUpInbox } from './surfaces';
import { followUpsToday } from './today';
import { draftInWhatsapp, MAX_DRAFT } from './whatsapp';

const logger = createLogger('FollowUps');

/** A panel command: its result, or the plain sentence of what went wrong. */
export function command<S extends z.ZodType>(
  type: `followups_${string}`,
  schema: S,
  run: (input: z.infer<S>) => Promise<unknown>,
): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      context.reply({ type: 'followups_ok', requestId: context.requestId, result: await run(input) });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
    }
  });
}

const updateId = z.string().regex(/^pu_[a-z2-7]{10}$/);
const taskId = z.string().min(1).max(40);

// Avi's answer to "Ada said she finished X. Mark done?": only his click closes the task
command('followups_mark_done', z.object({ updateId, taskId, answer: z.enum(['done', 'no']) }), async input => {
  const update = await personUpdateStore.get(input.updateId);
  if (!update?.offers?.some(offer => offer.taskId === input.taskId)) throw new Error('That suggestion is gone.');
  if (input.answer === 'done') {
    const current = await taskStore.get(input.taskId);
    if (!current) throw new Error('That task is no longer on the board.');
    if (current.status === 'dropped') throw new Error('That task was dropped, so it was left as it is.');
    if (current.status === 'open' && !(await taskStore.setStatus(input.taskId, 'done', 'avi'))) {
      throw new Error('That task is no longer on the board.');
    }
  }
  return personUpdateStore.answerOffer(input.updateId, input.taskId, input.answer, Date.now());
});

// ── Today's follow-ups and their card (Part 9.2, 9.3) ──

// What a card or the Inbox shows: today's picks, the ones still due first
command('followups_today', z.object({}), async () => {
  const due = await followUpsToday();
  return due.map(item => ({ taskId: item.task.id, reason: item.reason, since: item.since }));
});

// The message for one follow-up, ready to copy: the light model words it from fixed facts, else a template
command('followups_draft', z.object({ taskId }), input => draftFor(input.taskId));

// "Asked": the next follow-up two working days on
command('followups_asked', z.object({ taskId }), input => markAsked(input.taskId));

// "Snooze" one, three or seven days
command('followups_snooze', z.object({ taskId, days: z.union([z.literal(1), z.literal(3), z.literal(7)]) }), input =>
  snooze(input.taskId, input.days),
);

// "Draft in WhatsApp": typed into their chat in Avi's own WhatsApp Web tab; he sends it
command('followups_draft_whatsapp', z.object({ taskId, text: z.string().trim().min(1).max(MAX_DRAFT) }), input =>
  draftInWhatsapp(input.taskId, input.text),
);

// What Avi reports back about a person, from their page or a card ("the deck is with design, ready Thursday")
command(
  'followups_report',
  z.object({ personId: z.string().min(1).max(40), words: z.string().trim().min(2).max(1000) }),
  input => recordReport({ personId: input.personId, words: input.words, source: { kind: 'manual' }, at: Date.now() }),
);

registerFollowUpTools();

// Every morning: today's follow-ups as one Inbox item (the brief makes it too, when it runs first)
export const DAILY_JOB = 'followups_daily';
registerJobHandler(DAILY_JOB, async () => {
  await postFollowUpInbox().catch(error => logger.warning('Could not post the follow-ups', toAppError(error).kind));
});
registerRecovery('followups', async () => {
  await jobs.schedule({ kind: DAILY_JOB, key: DAILY_JOB, cron: '30 8 * * *', catchUpMs: 10 * 3600_000 });
});

// A name asked about and settled, people merged or removed: their updates follow
onPeopleChange(event => {
  const run = async () => {
    if (event.kind === 'settled' && event.personId) {
      const candidate = await db.peopleNames.get(event.candidateId);
      if (candidate) {
        const names = [candidate.text, ...candidate.otherTexts.map(other => other.text)];
        await personUpdateStore.link(names, event.personId, candidate.workspaceId);
      }
    } else if (event.kind === 'merged') {
      await personUpdateStore.replacePerson(event.droppedId, event.keptId);
    } else if (event.kind === 'removed') {
      await personUpdateStore.replacePerson(event.personId, null);
    }
  };
  void run().catch(error =>
    logger.warning('Could not move updates to the person they belong to', toAppError(error).kind),
  );
});

// Only pages of the extension send these, never a web page and never an agent
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if (typeof message?.type !== 'string' || !message.type.startsWith('followups_')) return;
  return answerOneOff(message, sendResponse);
});
