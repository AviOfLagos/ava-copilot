import { db, followUpDraftStore, peopleStore, stripTaskMarkers, taskStore } from '@extension/storage';
import type { Task } from '@extension/storage';
import { wrapUntrustedContent } from '../agent/messages/utils';
import { generatePlainText } from '../llm/generate';
import { systemMessage, userMessage } from '../llm/messages';
import { createLogger } from '../log';
import { lightModel } from '../models/light';
import { resolveModels } from '../threads/factory';
import { isOverDailyBudget } from '../usage/budget';

/**
 * The message for a follow-up (docs/pm-desk.md, Part 9.3). The facts come from code; the light model only words them,
 * and its text is kept only when it passes `checkDraft`, else a fixed template is used. Nothing here sends anything.
 */

const logger = createLogger('FollowUps');

export interface DraftFacts {
  // The first word of the person's name
  name: string;
  // The task, one line
  task: string;
  // Where it came from: "Tuesday's call", "WhatsApp"; null when not known
  from: string | null;
  // The due date as "Friday" or "20 Nov"; null when none
  date: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_DAYS = 6;

const oneLine = (text: string, max: number) => stripTaskMarkers(text.replace(/\s+/g, ' ').trim()).slice(0, max);
const firstWord = (text: string) => oneLine(text, 60).split(' ')[0] ?? '';

function dayName(at: number, now: number): string {
  const date = new Date(at);
  const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / DAY_MS);
  if (days >= 0 && days <= RECENT_DAYS) return `${date.toLocaleDateString('en-GB', { weekday: 'long' })}'s call`;
  return `the call on ${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

/** "Friday" when the day is within the next six days, else "20 Nov". */
export function dueWords(iso: string, now: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  const ahead = Math.round((date.getTime() - new Date(now).setHours(12, 0, 0, 0)) / DAY_MS);
  return ahead >= 0 && ahead <= RECENT_DAYS
    ? date.toLocaleDateString('en-GB', { weekday: 'long' })
    : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** The facts of one follow-up, all from code. */
export async function factsFor(task: Task, now = Date.now()): Promise<DraftFacts> {
  const person = task.ownerId ? await peopleStore.get(task.ownerId) : undefined;
  let from: string | null = null;
  if (task.source.kind === 'meeting' && task.source.id) {
    const meeting = await db.meetings.get(task.source.id).catch(() => undefined);
    from = meeting?.startedAt ? dayName(meeting.startedAt, now) : 'our call';
  } else if (task.source.kind === 'whatsapp') from = 'WhatsApp';
  else if (task.source.kind === 'chat') from = 'our chat';
  return {
    name: firstWord(person?.name || task.ownerName || ''),
    task: oneLine(task.title, 160),
    from,
    date: task.due ? dueWords(task.due, now) : null,
  };
}

/** The fixed wording, used with no model or when the model's text fails the check. */
export function templateDraft(facts: DraftFacts): string {
  const greeting = facts.name ? `Hi ${facts.name}` : 'Hi';
  const from = facts.from ? ` from ${facts.from}` : '';
  const due = facts.date ? ` It was due ${facts.date}.` : '';
  return `${greeting}, checking on "${facts.task}"${from}.${due} Where has that got to?`;
}

/** The model's text when it can be trusted, else null. */
export function checkDraft(text: string, facts: DraftFacts): string | null {
  const clean = text
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
  if (clean.length < 10 || clean.length > 500) return null;
  if (facts.name && !clean.toLowerCase().includes(facts.name.toLowerCase())) return null;
  if (/https?:\/\/|www\./i.test(clean)) return null;
  if (/\btsk_/.test(clean)) return null;
  if (/\n\s*\n/.test(clean)) return null;
  return clean;
}

const INSTRUCTIONS = [
  'Write one short, friendly WhatsApp message from the user to a colleague, checking on one task.',
  'Start with "Hi <name>".',
  'Use only the facts given: no new dates, promises or links, and no emojis.',
  'Under 45 words. End with a question.',
  'Reply with the message only.',
].join(' ');

async function wordIt(taskId: string, facts: DraftFacts): Promise<string | null> {
  if (await isOverDailyBudget()) return null;
  const scope = { sessionId: `followups:${taskId}`, notify: () => {} };
  const { chatModel } = await lightModel('draft', scope, async () => (await resolveModels(null, scope)).navigator);
  const text = await generatePlainText({
    chatModel,
    messages: [systemMessage(INSTRUCTIONS), userMessage(wrapUntrustedContent(JSON.stringify(facts)))],
  });
  return checkDraft(text, facts);
}

/** The message for one follow-up: from the cache, else worded by the light model, else the template. */
export async function draftFor(taskId: string): Promise<{ text: string; facts: DraftFacts; byModel: boolean }> {
  const task = await taskStore.get(taskId);
  if (!task) throw new Error('That task is no longer on the board.');
  const facts = await factsFor(task);
  const key = JSON.stringify([facts.name, facts.task, facts.from, facts.date]);
  const kept = await followUpDraftStore.get(taskId, key).catch(() => null);
  if (kept) return { text: kept.text, facts, byModel: kept.byModel };
  let text: string | null = null;
  try {
    text = await wordIt(taskId, facts);
  } catch (error) {
    logger.warning('The model could not word the follow-up', error instanceof Error ? error.name : 'unknown');
  }
  const result = { text: text ?? templateDraft(facts), byModel: text !== null };
  await followUpDraftStore.set(taskId, { key, ...result, at: Date.now() }).catch(() => undefined);
  return { ...result, facts };
}
