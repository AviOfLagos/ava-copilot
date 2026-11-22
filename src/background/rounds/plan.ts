import type { RoundId, RoundsState } from '@extension/storage';

/**
 * When rounds run and when a check-in may be offered (docs/growth-team.md, Part 4). Pure arithmetic on the
 * clock and on what already happened today, so every rule here is tested without a browser.
 */

export interface RoundPlan {
  id: RoundId;
  // Local times, "HH:MM"
  times: string[];
}

export const ROUNDS: RoundPlan[] = [
  { id: 'pulse', times: ['08:30', '16:00'] },
  { id: 'mail', times: ['09:00', '14:00'] },
  { id: 'stuck', times: ['12:00'] },
];

export const CHECKIN = {
  // Between these local hours only
  fromHour: 9,
  toHour: 18,
  quietMs: 3 * 60 * 60 * 1000,
  perDay: 2,
} as const;

const pad = (value: number) => String(value).padStart(2, '0');

/** The user's local day, YYYY-MM-DD. */
export const localDay = (at: number): string => {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export const localTime = (at: number): string => {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const slotKey = (round: RoundId, time: string) => `${round}|${time}`;

export interface DueRound {
  round: RoundId;
  // The slot that runs now
  time: string;
  // Earlier slots of the same round that were missed today: marked as skipped, never run after the fact
  skipped: string[];
}

/**
 * The one round to run now, or null. A slot is due from its time until the end of that day. When several slots
 * of one round were missed (the browser was closed), only the latest runs and the earlier ones are skipped: a
 * round never runs twice in a row to catch up. Rounds take turns: the one whose due slot is oldest goes first.
 */
export function dueRound(now: number, ran: RoundsState['ran'], rounds: RoundPlan[] = ROUNDS): DueRound | null {
  const time = localTime(now);
  let best: DueRound | null = null;
  for (const plan of rounds) {
    const passed = plan.times.filter(slot => slot <= time).sort();
    const latest = passed[passed.length - 1];
    if (latest === undefined || slotKey(plan.id, latest) in ran) continue;
    const skipped = passed.slice(0, -1).filter(slot => !(slotKey(plan.id, slot) in ran));
    if (best === null || latest < best.time) best = { round: plan.id, time: latest, skipped };
  }
  return best;
}

export interface CheckInFacts {
  now: number;
  // When the user last gave a task (typed, said, or sent from the phone); null when never
  lastTaskAt: number | null;
  // When the browser session started: quiet time is not counted from before the user was there
  startedAt: number;
  offersToday: number;
  lastOfferAt: number;
  silenced: boolean;
  inMeeting: boolean;
  // A round is running or due right now: it goes first
  roundDue: boolean;
}

/**
 * Whether a check-in may be offered now: between 09:00 and 18:00, after three quiet hours, at most twice a day,
 * not after "Not today", never during a meeting, and never on top of a round. Returns why not, for the log.
 */
export function checkInDue(facts: CheckInFacts): { due: true } | { due: false; why: string } {
  const hour = new Date(facts.now).getHours();
  if (hour < CHECKIN.fromHour || hour >= CHECKIN.toHour) return { due: false, why: 'outside 09:00 to 18:00' };
  if (facts.silenced) return { due: false, why: 'silenced until tomorrow' };
  if (facts.offersToday >= CHECKIN.perDay) return { due: false, why: 'two offers already today' };
  if (facts.inMeeting) return { due: false, why: 'in a meeting' };
  if (facts.roundDue) return { due: false, why: 'a round goes first' };
  const quietSince = Math.max(facts.lastTaskAt ?? 0, facts.startedAt, facts.lastOfferAt);
  if (facts.now - quietSince < CHECKIN.quietMs) return { due: false, why: 'not quiet for three hours yet' };
  return { due: true };
}

/**
 * "What changed" for one number: today against the average of the days before it, flagged when the change is
 * at least 50% and at least 5 in absolute terms. Arithmetic, never a model call. Days with no reading are left
 * out of the average; with none to compare with, nothing is flagged.
 */
export function whatChanged(
  today: number | null,
  before: (number | null)[],
): { average: number | null; change: number | null; flagged: boolean; direction: 'up' | 'down' | null } {
  const known = before.filter((value): value is number => value !== null);
  if (today === null || known.length === 0) return { average: null, change: null, flagged: false, direction: null };
  const average = known.reduce((sum, value) => sum + value, 0) / known.length;
  const change = today - average;
  const size = Math.abs(change);
  const flagged = size >= 5 && size >= 0.5 * average;
  return { average, change, flagged, direction: flagged ? (change > 0 ? 'up' : 'down') : null };
}
