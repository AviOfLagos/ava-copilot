import { dayEnd, shiftDay } from '@extension/storage';
import type { GrowthMetric, GrowthReading, GrowthSourceState, GrowthStore, NoReadingReason } from '@extension/storage';

/**
 * How numbers are read back (docs/growth-team.md, Part 7): the numbers, when they were read, and for every day
 * that has none, that it has none and why. A missing number is never a zero, here or in what the model is told.
 */

export type QueryBy = 'day' | 'channel' | 'campaign';

// Numbers that say how things stand at one moment, not how many happened in a day: they are never added up
// across days. Seven days of "10 orgs" is 10 orgs, not 70.
export const SNAPSHOT_METRICS = new Set(['orgs', 'active_orgs', 'paid_orgs']);
export const MAX_RANGE_DAYS = 92;

export interface MetricQuery {
  productId: string;
  metric: string;
  // UTC days, both included
  from: string;
  to: string;
  by?: QueryBy;
}

export interface MetricAnswer {
  productId: string;
  metric: string;
  from: string;
  to: string;
  // The sum over the days that were read, or for a number that says how things stand (orgs) the latest one
  // read; null when no day in the range was read
  total: number | null;
  // A standing number: `total` is the latest reading, taken on this day
  latestOn: string | null;
  // Days read before they were over: their numbers are "so far"
  unfinished: string[];
  // Some day's list was cut at the product's row limit: the total is "at least" this
  atLeast: boolean;
  daysRead: number;
  daysAsked: number;
  // When the newest and the oldest of the numbers were read
  readAt: { newest: number; oldest: number } | null;
  byDay: {
    date: string;
    value: number | null;
    readAt: number | null;
    reason: NoReadingReason | null;
    detail: string | null;
  }[];
  by: QueryBy | null;
  // The split asked for, largest first; empty when none was asked for or none is known
  parts: { name: string; value: number }[];
  // Whether the source that reports this metric can be reached now
  source: Pick<GrowthSourceState, 'status' | 'reason' | 'detail' | 'lastOkAt'> | null;
}

const isDay = (text: string) => /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`));

export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to && days.length <= MAX_RANGE_DAYS; day = shiftDay(day, 1)) days.push(day);
  return days;
}

/** Checks a range: two real days in order, at most 92 days apart. Returns what is wrong, or null. */
export function rangeProblem(from: string, to: string): string | null {
  if (!isDay(from) || !isDay(to)) return 'Give the days as YYYY-MM-DD.';
  if (from > to) return 'The first day is after the last day.';
  if (daysBetween(from, to).length > MAX_RANGE_DAYS) return `A range covers at most ${MAX_RANGE_DAYS} days.`;
  return null;
}

/** Answers one question about one metric of one product. */
export async function queryMetric(store: GrowthStore, query: MetricQuery): Promise<MetricAnswer> {
  const [rows, readings] = await Promise.all([
    store.metrics(query.productId, query.metric, query.from, query.to),
    store.readings(query.productId, query.metric, query.from, query.to),
  ]);
  const readingOf = new Map<string, GrowthReading>(readings.map(reading => [reading.date, reading]));
  const totals = new Map<string, GrowthMetric>();
  const parts = new Map<string, number>();
  for (const row of rows) {
    // A day's rows count only when that day was read
    if (readingOf.get(row.date)?.status !== 'ok') continue;
    const split = row.channel !== undefined || row.campaign !== undefined || row.postId !== undefined;
    if (!split) totals.set(row.date, row);
    const name = query.by === 'channel' ? row.channel : query.by === 'campaign' ? row.campaign : undefined;
    if (name !== undefined) parts.set(name, (parts.get(name) ?? 0) + row.value);
  }

  const days = daysBetween(query.from, query.to);
  const byDay = days.map(date => {
    const reading = readingOf.get(date);
    const row = totals.get(date);
    return reading?.status === 'ok' && row
      ? { date, value: row.value, readAt: row.readAt, reason: null, detail: null }
      : { date, value: null, readAt: null, reason: reading?.reason ?? null, detail: reading?.detail ?? null };
  });
  const read = byDay.filter(day => day.value !== null);
  const snapshot = SNAPSHOT_METRICS.has(query.metric);
  const latest = read[read.length - 1];
  const source = readings[0] ? await store.sourceState(query.productId, readings[0].source) : undefined;
  return {
    productId: query.productId,
    metric: query.metric,
    from: query.from,
    to: query.to,
    total: !read.length
      ? null
      : snapshot
        ? (latest?.value ?? null)
        : read.reduce((sum, day) => sum + (day.value ?? 0), 0),
    latestOn: snapshot ? (latest?.date ?? null) : null,
    unfinished: snapshot ? [] : read.filter(day => (day.readAt ?? 0) < dayEnd(day.date)).map(day => day.date),
    atLeast: readings.some(reading => reading.status === 'ok' && reading.partial === true),
    daysRead: read.length,
    daysAsked: days.length,
    readAt: read.length
      ? {
          newest: Math.max(...read.map(day => day.readAt ?? 0)),
          oldest: Math.min(...read.map(day => day.readAt ?? 0)),
        }
      : null,
    byDay,
    by: query.by ?? null,
    parts: [...parts.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name)),
    source: source
      ? { status: source.status, reason: source.reason, detail: source.detail, lastOkAt: source.lastOkAt }
      : null,
  };
}

const stamp = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const amount = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2));

/** Days in a row with the same reason, as "2026-11-18 to 2026-11-19". */
function spans(days: string[]): string {
  const out: string[] = [];
  let start = days[0];
  let last = days[0];
  for (const day of days.slice(1)) {
    if (last !== undefined && day === shiftDay(last, 1)) {
      last = day;
      continue;
    }
    out.push(start === last ? `${start}` : `${start} to ${last}`);
    start = last = day;
  }
  if (start !== undefined) out.push(start === last ? `${start}` : `${start} to ${last}`);
  return out.join(', ');
}

/**
 * The answer in words, for the model. It says "no reading" for every day with no number and tells the model not
 * to read that as zero, because a model given a blank will otherwise fill it.
 */
export function answerText(answer: MetricAnswer, productName: string): string {
  const head = `${productName} · ${answer.metric} · ${answer.from === answer.to ? answer.from : `${answer.from} to ${answer.to}`} (UTC days)`;
  const lines = [head];
  const missing = answer.byDay.filter(day => day.value === null);

  if (answer.total === null) {
    const down = answer.source?.status === 'not_connected';
    const why = missing.find(day => day.detail)?.detail ?? answer.source?.detail ?? 'Nothing has read this metric yet.';
    lines.push(`${down ? 'Not connected' : 'No reading'}: ${why}`);
    lines.push('There is no number for this. Do not say 0 or guess one: say it is not known yet, and why.');
    return lines.join('\n');
  }

  if (answer.latestOn) {
    // How things stand, not a count of events: the latest reading, never a sum
    lines.push(
      `Latest: ${answer.atLeast ? 'at least ' : ''}${amount(answer.total)} (as it stood on ${answer.latestOn})`,
    );
  } else {
    lines.push(
      `Total: ${answer.atLeast ? 'at least ' : ''}${amount(answer.total)} over ${answer.daysRead} of ${answer.daysAsked} ${answer.daysAsked === 1 ? 'day' : 'days'}`,
    );
  }
  if (answer.readAt) {
    lines.push(
      answer.readAt.newest === answer.readAt.oldest
        ? `Read: ${stamp(answer.readAt.newest)}`
        : `Read: between ${stamp(answer.readAt.oldest)} and ${stamp(answer.readAt.newest)}`,
    );
  }
  if (answer.parts.length) {
    lines.push(`By ${answer.by}: ${answer.parts.map(part => `${part.name} ${amount(part.value)}`).join('; ')}`);
  } else if (answer.by === 'channel' || answer.by === 'campaign') {
    lines.push(`By ${answer.by}: nothing recorded.`);
  }
  if (answer.daysAsked > 1) {
    lines.push(
      `By day: ${answer.byDay.map(day => `${day.date} ${day.value === null ? 'no reading' : amount(day.value)}`).join('; ')}`,
    );
  }
  if (answer.unfinished.length) {
    lines.push(
      `Not final: ${spans(answer.unfinished)} ${answer.unfinished.length === 1 ? 'was' : 'were'} read before the day was over, so ${answer.unfinished.length === 1 ? 'its number is' : 'their numbers are'} the count so far.`,
    );
  }
  if (missing.length) {
    const groups = new Map<string, string[]>();
    for (const day of missing) {
      const why = day.detail ?? 'nothing read it';
      groups.set(why, [...(groups.get(why) ?? []), day.date]);
    }
    for (const [why, dates] of groups) lines.push(`No reading for ${spans(dates)}: ${why}`);
    lines.push('A day with no reading is not a zero: the number above leaves those days out.');
  }
  return lines.join('\n');
}
