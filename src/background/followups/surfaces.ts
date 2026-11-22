import { db, isoDay, peopleStore, stripTaskMarkers } from '@extension/storage';
import type { Person } from '@extension/storage';
import { addInboxItem, inboxItemId } from '../inbox/store';
import { defaultTodayDeps, followUpsToday } from './today';
import type { TodayDeps } from './today';
import type { DueFollowUp, FollowUpReason } from './rules';
import { dayLabel } from './status';

/**
 * Where today's follow-ups show (docs/pm-desk.md, Part 9.2): the brief's "Follow up today", WhatsApp's "who's next"
 * (through the hook in ../whatsapp-remote/register.ts) and one Inbox item a day. The same five everywhere.
 */

/** One follow-up as the brief and the Inbox say it: who, what, and why today, all plain. */
export interface FollowUpItem {
  taskId: string;
  // The name Avi uses for them: the person's name, else the owner's name as said
  name: string;
  title: string;
  reason: FollowUpReason;
  // A short "why today" in words: "due Fri 20 Nov", "quiet since Tue 17 Nov", "asked Mon 23 Nov"
  why: string;
}

const plain = (text: string, max: number) => stripTaskMarkers(text.replace(/\s+/g, ' ').trim()).slice(0, max);

/** The name a follow-up uses: the person Avi knows, else the owner's name as it was said. */
export function nameFor(task: DueFollowUp['task'], peopleById: ReadonlyMap<string, Pick<Person, 'name'>>): string {
  return plain((task.ownerId && peopleById.get(task.ownerId)?.name) || task.ownerName || '', 60);
}

/** Why it is due today, in a few words. */
export function whyText(item: DueFollowUp, heardDay?: string): string {
  const task = item.task;
  switch (item.reason) {
    case 'overdue':
      return `due ${dayLabel(task.due!)}`;
    case 'asked':
      return task.followUp?.askedAt
        ? `asked ${dayLabel(isoDay(task.followUp.askedAt))}, no answer yet`
        : 'asked, no answer yet';
    case 'snoozed':
      return 'snoozed until today';
    case 'update':
      return 'the day they gave has come';
    default:
      return heardDay ? `nothing heard since ${dayLabel(heardDay)}` : 'nothing heard for three working days';
  }
}

/** Today's follow-ups as the brief and the Inbox list them. */
export async function followUpItems(deps: TodayDeps = defaultTodayDeps): Promise<FollowUpItem[]> {
  const due = await followUpsToday(deps);
  if (!due.length) return [];
  const peopleById = new Map((await peopleStore.list().catch(() => [] as Person[])).map(person => [person.id, person]));
  return due.map(item => ({
    taskId: item.task.id,
    name: nameFor(item.task, peopleById),
    title: plain(item.task.title, 160),
    reason: item.reason,
    why: whyText(item),
  }));
}

/** "Ada: Send the login (due Fri 20 Nov)". */
export const followUpText = (item: Pick<FollowUpItem, 'name' | 'title' | 'why'>) =>
  `${item.name}: ${item.title} (${item.why})`;

export const INBOX_SOURCE = 'followups';
export const inboxExternalId = (day: string) => `day:${day}`;

/**
 * Today's one Inbox item: who to follow up with. Made once a day, and brought up to date while it is not done
 * (later picks of the same day join it). Nothing to chase, no item.
 */
export async function postFollowUpInbox(
  now = Date.now(),
  items?: Pick<FollowUpItem, 'name' | 'title' | 'why'>[],
): Promise<boolean> {
  const list = items ?? (await followUpItems());
  if (!list.length) return false;
  const people = new Set(list.map(item => item.name.trim().toLowerCase())).size;
  const day = isoDay(now);
  const title =
    people === 1
      ? list.length === 1
        ? `Follow up with ${list[0].name} today`
        : `Follow up with ${list[0].name} today: ${list.length} things`
      : `Follow up today: ${people} people to chase`;
  const body = list.map(item => `- ${followUpText(item)}`).join('\n');
  const id = inboxItemId(INBOX_SOURCE, inboxExternalId(day));
  const existing = await db.inbox.get(id);
  if (existing) {
    if (existing.status !== 'done' && existing.body !== body)
      await db.inbox.update(id, { title, body, updatedAt: now });
    return true;
  }
  await addInboxItem({ source: INBOX_SOURCE, externalId: inboxExternalId(day), kind: 'alert', title, body });
  return true;
}
