import { STALE_START_MS } from '@extension/storage';
import type { StandupExperiment, StandupNote, StandupRecord, StandupTodayItem, WeekPlan } from '@extension/storage';

/**
 * The rules of the weekly plan and the daily standup (docs/growth-team.md, Part 10), as plain functions: the
 * clock, the word limits, and which "today" items are off plan. No model and no storage here.
 */

// Monday 07:30 and every day 07:45, local time
export const PLAN_CRON = '30 7 * * 1';
export const STANDUP_CRON = '45 7 * * *';
export const STANDUP_MINUTE = 7 * 60 + 45;
// A missed standup runs once if the browser opens before noon; after that it is skipped
export const STANDUP_LAST_MINUTE = 12 * 60;
// The brief waits for a running standup until 07:58, or this long after a late one started
export const BRIEF_WAITS_MINUTE = 7 * 60 + 58;
export const BRIEF_WAITS_MS = (BRIEF_WAITS_MINUTE - STANDUP_MINUTE) * 60_000;

export const NOTE_WORDS = 80;
export const SUMMARY_WORDS = 200;
export const MAX_EXPERIMENTS = 3;
// "Today" items a note may have, and how many off-plan items the summary's line lists by name
export const MAX_TODAY = 3;
const MAX_LISTED = 5;

/** Local date, YYYY-MM-DD. */
export function localDay(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function minuteOfDay(at: number): number {
  const date = new Date(at);
  return date.getHours() * 60 + date.getMinutes();
}

/** The local Monday of the week `at` falls in. */
export function weekOf(at: number): string {
  const date = new Date(at);
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return localDay(date.getTime());
}

/** The week's plan is missing or from an earlier week, and the week's 07:30 on Monday has passed. */
export function planDue(plan: WeekPlan | null, now: number): boolean {
  if (plan && plan.weekOf === weekOf(now)) return false;
  const monday = new Date(now);
  return !(monday.getDay() === 1 && minuteOfDay(now) < 7 * 60 + 30);
}

export type StandupDecision = { run: true } | { run: false; skip: string | null };

/**
 * Whether today's standup runs now: once a day, from 07:45 until noon. After noon it is skipped and says why;
 * before 07:45 it is simply not time yet.
 */
export function standupDecision(record: StandupRecord | null, started: number | null, now: number): StandupDecision {
  if (record) return { run: false, skip: null };
  // A start the background lost (closed mid-run) does not hold the day
  if (started !== null && now - started >= STALE_START_MS) started = null;
  const minute = minuteOfDay(now);
  if (minute < STANDUP_MINUTE) return { run: false, skip: null };
  if (started !== null) return { run: false, skip: null };
  if (minute >= STANDUP_LAST_MINUTE) {
    return { run: false, skip: 'the browser was not open between 07:45 and 12:00' };
  }
  return { run: true };
}

/** Whether the morning brief should wait for today's standup: it is running, and not past 07:58 or its wait. */
export function briefShouldWait(record: StandupRecord | null, started: number | null, now: number): boolean {
  if (record) return false;
  if (started !== null) return now - started < BRIEF_WAITS_MS;
  const minute = minuteOfDay(now);
  // Due and about to start
  return minute >= STANDUP_MINUTE && minute < BRIEF_WAITS_MINUTE;
}

export const wordsIn = (text: string) => text.split(/\s+/).filter(Boolean).length;

function cutTo(text: string, words: number): string {
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length <= words) return parts.join(' ');
  return `${parts.slice(0, Math.max(words, 1)).join(' ')}…`;
}

/**
 * A note held to its limit: the longest part is cut a word at a time until the whole fits, so every part keeps
 * something. The "today" items keep their link to an experiment whatever their text becomes.
 */
export function fitNote(note: StandupNote, limit = NOTE_WORDS): StandupNote {
  const parts = {
    did: note.did,
    learned: note.learned,
    blocked: note.blocked,
    ...Object.fromEntries(note.today.map((item, index) => [`today${index}`, item.text])),
  } as Record<string, string>;
  const counts = Object.fromEntries(Object.entries(parts).map(([key, text]) => [key, wordsIn(text)]));
  let total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  while (total > limit) {
    const [longest] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!;
    if (counts[longest]! <= 1) break;
    counts[longest]! -= 1;
    total -= 1;
  }
  const fit = (key: string) => (wordsIn(parts[key]!) > counts[key]! ? cutTo(parts[key]!, counts[key]!) : parts[key]!);
  return {
    ...note,
    did: fit('did'),
    learned: fit('learned'),
    blocked: fit('blocked'),
    today: note.today.map((item, index) => ({ ...item, text: fit(`today${index}`) })),
  };
}

/** Text held to a number of words. */
export function fitWords(text: string, limit: number): string {
  if (wordsIn(text) <= limit) return text.trim();
  // Lines are kept where they fall, so a list stays a list
  let left = limit;
  const lines: string[] = [];
  for (const line of text.trim().split('\n')) {
    const count = wordsIn(line);
    if (count <= left) {
      lines.push(line);
      left -= count;
      continue;
    }
    if (left > 0) lines.push(cutTo(line, left));
    break;
  }
  return lines.join('\n');
}

/**
 * Marks each "today" item that names none of the week's experiments as off plan, with the agent's reason. An item
 * names an experiment by its id (E1) or by what it tries.
 */
export function markOffPlan(
  items: { text: string; experiment?: string | null; reason?: string | null }[],
  experiments: StandupExperiment[],
): StandupTodayItem[] {
  return items.slice(0, MAX_TODAY).map(item => {
    const named = experiments.find(
      experiment =>
        (item.experiment ?? '').trim().toUpperCase() === experiment.id.toUpperCase() ||
        new RegExp(`\\b${experiment.id}\\b`, 'i').test(item.text) ||
        (experiment.what.trim().length > 0 && item.text.toLowerCase().includes(experiment.what.trim().toLowerCase())),
    );
    return named
      ? { text: item.text, experiment: named.id, offPlan: false, reason: '' }
      : {
          text: item.text,
          experiment: null,
          offPlan: true,
          reason: cutTo(item.reason?.trim() || 'no reason given', 15),
        };
  });
}

/** The off-plan items of all notes, by agent. */
export function offPlanItems(notes: StandupNote[]): StandupRecord['offPlan'] {
  return notes.flatMap(note =>
    note.today
      .filter(item => item.offPlan)
      .map(item => ({ agentName: note.agentName, text: item.text, reason: item.reason })),
  );
}

/** What code adds to the Growth Lead's summary when more than one item is off plan: each, by name. */
export function offPlanLine(offPlan: StandupRecord['offPlan']): string {
  if (offPlan.length <= 1) return '';
  const more = offPlan.length - MAX_LISTED;
  return `Off plan (${offPlan.length}): ${offPlan
    .slice(0, MAX_LISTED)
    .map(item => `${item.agentName}: "${cutTo(item.text, 12)}" (${cutTo(item.reason, 12)})`)
    .join('; ')}${more > 0 ? `; and ${more} more` : ''}.`;
}

/** The summary as it is kept and shown: the Lead's words within 200 words, the off-plan line included. */
export function composeSummary(written: string, offPlan: StandupRecord['offPlan'], notes: string[] = []): string {
  // Lines code adds (the off-plan items, numbers no reading holds) keep their room; the whole stays within 200
  const added = [offPlanLine(offPlan), ...notes].filter(Boolean);
  const room = SUMMARY_WORDS - added.reduce((sum, line) => sum + wordsIn(line), 0);
  return fitWords([fitWords(written, Math.max(room, 40)), ...added].join('\n\n'), SUMMARY_WORDS);
}

/** A note as the Inbox shows it. */
export function noteText(note: StandupNote): string {
  const today = note.today.length
    ? note.today
        .map(item => (item.offPlan ? `${item.text} (off plan: ${item.reason})` : `${item.text} (${item.experiment})`))
        .join('; ')
    : 'nothing planned';
  return [
    note.agentName,
    `Did: ${note.did || 'nothing'}`,
    `Learned: ${note.learned || 'nothing new'}`,
    `Today: ${today}`,
    `Blocked: ${note.blocked || 'nothing'}`,
  ].join('\n');
}

/** The week's plan as the agents and the Inbox read it. */
export function planText(plan: WeekPlan): string {
  return [
    `Week of ${plan.weekOf}. Focus: ${plan.focus}`,
    ...plan.experiments.map(
      experiment =>
        `${experiment.id}. ${experiment.what}. Moves: ${experiment.metric}. By Friday we know if: ${experiment.howWeKnow}. Owner: ${experiment.owner}.`,
    ),
  ].join('\n');
}
