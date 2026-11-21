import { growthStore, shiftDay, utcDay } from '@extension/storage';
import type { GrowthStore, ProductProfile } from '@extension/storage';
import { PRODUCT_METRICS } from '../../growth/collect';

/**
 * No invented numbers or quotes (docs/growth-team.md, Part 8 and "Evals"): a post, reply or listing an agent
 * writes may state a number only when the product profile or the metrics store holds it, and may not quote
 * anyone, because a customer is never quoted without their written yes and code cannot see that yes. Plain code,
 * run by the queue on every agent draft before it reaches the Inbox.
 */

// How far back a number may come from: as far as metrics_query reads (growth/query.ts, MAX_RANGE_DAYS)
const FACT_DAYS = 92;
// Small counts ("3 things we learned") are words more than facts
const SMALL = 10;
// Numbers a tool showed an agent stay usable this long
const SHOWN_MS = 24 * 60 * 60_000;

export type FactStore = Pick<GrowthStore, 'metrics' | 'readings'>;

/** Known numbers, and the changes in per cent that only a number written with "%" may match. */
export type KnownNumbers = ReadonlySet<number> & { percents?: ReadonlySet<number> };

const round2 = (value: number) => Math.round(value * 100) / 100;

const add = (set: Set<number>, value: number | null | undefined) => {
  if (typeof value === 'number' && Number.isFinite(value)) set.add(round2(value));
};

const UNITS: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

interface NumberToken {
  text: string;
  // What it may mean: "1.200" is 1.2 in one place and 1200 in another, so it has two readings
  values: number[];
  // How far from the value a known number may be and still be this one: "12k" is 11,500 to 12,499
  tolerance: number;
  percent: boolean;
}

/**
 * The numbers in a text, with "12k", "1.5m" and "100x" read as what they say. A number glued to letters
 * ("50ms", "v2", "3rd") is a unit or a name, not a count, and is left alone.
 */
function numberTokens(text: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  const pattern = /(?<![\w.,])(\d(?:[\d.,]*\d)?)(?:\s?([kKmMbB])(?![A-Za-z]))?(x(?![A-Za-z]))?(%)?(?![\w])/g;
  for (const match of text.matchAll(pattern)) {
    const [whole, raw, unit, , percent] = match;
    const scale = unit ? UNITS[unit.toLowerCase()]! : 1;
    const readings = readingsOf(raw!);
    if (!readings.length) continue;
    tokens.push({
      text: whole!.trim(),
      values: readings.map(reading => reading.value * scale),
      tolerance: unit ? (0.5 * scale) / 10 ** Math.min(...readings.map(reading => reading.decimals)) : 0,
      percent: Boolean(percent),
    });
  }
  return tokens;
}

/** What a run of digits and separators may mean, with the number of decimals in each reading. */
function readingsOf(raw: string): { value: number; decimals: number }[] {
  const reading = (whole: string, fraction = '') => ({
    value: Number(`${whole.replace(/[.,]/g, '')}${fraction ? `.${fraction}` : ''}`),
    decimals: fraction.length,
  });
  const separators = raw.replace(/\d/g, '');
  let readings: { value: number; decimals: number }[];
  if (!separators) readings = [reading(raw)];
  else if (separators.includes('.') && separators.includes(',')) {
    // The last separator is the decimal one: 1,250.50 and 1.250,50
    const at = Math.max(raw.lastIndexOf('.'), raw.lastIndexOf(','));
    readings = [reading(raw.slice(0, at), raw.slice(at + 1))];
  } else {
    const groups = raw.split(/[.,]/);
    const grouped = groups.slice(1).every(group => group.length === 3);
    if (separators.length > 1) readings = grouped ? [reading(raw)] : [];
    else if (grouped) readings = [reading(raw), reading(groups[0]!, groups[1])];
    else readings = [reading(groups[0]!, groups[1])];
  }
  return readings.filter(item => Number.isFinite(item.value));
}

// What metrics_query, post_results and rank_channels showed, per workspace: a number a tool gave an agent is one
// it may use, whatever window it asked for
const shown = new Map<string, Map<number, number>>();

/** Remembers numbers a tool showed an agent of this workspace. */
export function rememberShown(workspaceId: string, values: (number | null | undefined)[], now = Date.now()): void {
  const known = shown.get(workspaceId) ?? new Map<number, number>();
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) known.set(round2(value), now);
  }
  shown.set(workspaceId, known);
}

/** For tests: forgets what tools showed. */
export function forgetShown(): void {
  shown.clear();
}

const percentChange = (current: number, before: number) => (before > 0 ? ((current - before) / before) * 100 : null);

/** The numbers a draft may state: from the profile, the metrics store, and what tools showed today. */
export async function knownNumbers(
  profile: ProductProfile,
  now: number,
  store: FactStore = growthStore,
): Promise<KnownNumbers> {
  const known = new Set<number>();
  const percents = new Set<number>();
  for (const text of [
    profile.pricing,
    profile.oneLiner,
    profile.problem,
    profile.postalAddress,
    ...profile.differentiators,
  ]) {
    for (const token of numberTokens(text ?? '')) for (const value of token.values) add(known, value);
  }
  add(known, profile.budget?.totalUsd);
  add(known, profile.betaRule?.testersPerWeek);
  add(known, profile.betaRule?.days);
  add(known, profile.northStar?.weeklyTarget);
  for (const [value, at] of shown.get(profile.workspaceId) ?? []) if (now - at < SHOWN_MS) known.add(value);

  const to = utcDay(now);
  const from = shiftDay(to, -(FACT_DAYS - 1));
  for (const metric of PRODUCT_METRICS) {
    const [rows, readings] = await Promise.all([
      store.metrics(profile.workspaceId, metric, from, to),
      store.readings(profile.workspaceId, metric, from, to),
    ]);
    // A day with no reading holds nothing, whatever its rows say
    const read = new Set(readings.filter(reading => reading.status === 'ok').map(reading => reading.date));
    const series = new Map<string, Map<string, number>>();
    for (const row of rows) {
      if (!read.has(row.date)) continue;
      add(known, row.value);
      const key = row.postId
        ? `post:${row.postId}`
        : row.campaign
          ? `campaign:${row.campaign}`
          : row.channel
            ? `channel:${row.channel}`
            : 'total';
      const days = series.get(key) ?? new Map<string, number>();
      days.set(row.date, (days.get(row.date) ?? 0) + row.value);
      series.set(key, days);
    }
    for (const days of series.values()) {
      const sumOf = (end: string, span: number) => {
        let sum = 0;
        for (let index = 0; index < span; index++) sum += days.get(shiftDay(end, -index)) ?? 0;
        return sum;
      };
      // Every window ending today (so far) or yesterday, as metrics_query would total it
      for (const end of [to, shiftDay(to, -1)]) {
        let sum = 0;
        for (let span = 1; span <= FACT_DAYS; span++) {
          sum += days.get(shiftDay(end, -(span - 1))) ?? 0;
          add(known, sum);
        }
        // Up or down on the window before: "up 40% on last week"
        for (const span of [7, 28]) {
          const change = percentChange(sumOf(end, span), sumOf(shiftDay(end, -span), span));
          if (change !== null) {
            add(percents, Math.abs(Math.round(change)));
            add(percents, Math.abs(Math.round(change * 10) / 10));
          }
        }
      }
      // Whole calendar months
      const months = new Map<string, number>();
      for (const [date, value] of days) months.set(date.slice(0, 7), (months.get(date.slice(0, 7)) ?? 0) + value);
      for (const value of months.values()) add(known, value);
    }
  }
  return Object.assign(known, { percents });
}

function isKnown(value: number, tolerance: number, known: ReadonlySet<number>): boolean {
  if (known.has(round2(value))) return true;
  if (!tolerance) return false;
  for (const item of known) if (Math.abs(item - value) <= tolerance) return true;
  return false;
}

/** A number that is not a fact: a small count, or a year. */
function notAFact(value: number, token: NumberToken): boolean {
  if (value <= SMALL) return true;
  return !token.tolerance && !token.percent && Number.isInteger(value) && value >= 1990 && value <= 2100;
}

/** The numbers in a draft that nothing known holds. Links, handles, tags, years, times and small counts are not facts. */
export function inventedNumbers(text: string, known: KnownNumbers): string[] {
  const plain = text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#][\w.-]+/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ');
  const found: string[] = [];
  for (const token of numberTokens(plain)) {
    // Fine when one reading is known, or when every reading is a small count or a year; "1.200" is checked as 1200
    const matches = (value: number) =>
      isKnown(value, token.tolerance, known) ||
      (token.percent && known.percents !== undefined && isKnown(value, token.tolerance, known.percents));
    if (token.values.some(value => !notAFact(value, token) && matches(value))) continue;
    if (token.values.every(value => notAFact(value, token))) continue;
    if (!found.includes(token.text)) found.push(token.text);
  }
  return found;
}

// Quotation marks, opening and closing: double, single, guillemets, corner brackets
const QUOTE_PAIRS: [string, string][] = [
  ['"', '"'],
  ['“', '”'],
  ['„', '“'],
  ['„', '”'],
  ['«', '»'],
  ['‘', '’'],
  ['‚', '‘'],
  ['‚', '’'],
  ['‹', '›'],
  ['「', '」'],
  ['『', '』'],
];
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Passages in quotation marks of four words or more, and Markdown quote lines: someone's words, which need their
 * written yes. Straight single quotes count only when they stand apart from words, so "it's" is not a quote.
 */
export function quotesIn(text: string): string[] {
  const passages: string[] = [];
  for (const [open, close] of QUOTE_PAIRS) {
    const pattern = new RegExp(`${escape(open)}([^${escape(open)}${escape(close)}\\n]{3,})${escape(close)}`, 'g');
    for (const match of text.matchAll(pattern)) passages.push(match[1]!);
  }
  for (const match of text.matchAll(/(?<![\w'])'([^'\n]{3,})'(?![\w'])/g)) passages.push(match[1]!);
  for (const match of text.matchAll(/^\s*>\s?(.+)$/gm)) passages.push(match[1]!);
  const found: string[] = [];
  for (const passage of passages) {
    const words = passage.trim().split(/\s+/).filter(Boolean);
    if (words.length >= 4 && !found.includes(passage.trim())) found.push(passage.trim());
  }
  return found;
}

/** Why an agent's draft may not reach the Inbox as written, or null when it may. */
export function factRefusal(text: string, known: KnownNumbers): string | null {
  const invented = inventedNumbers(text, known);
  if (invented.length) {
    return `The draft states ${invented.map(value => `"${value}"`).join(', ')}, which neither the product profile nor metrics_query holds. Use a number metrics_query gave you, or write it without the number.`;
  }
  const quotes = quotesIn(text);
  if (quotes.length) {
    return `The draft quotes someone ("${quotes[0]!.slice(0, 60)}"). Nobody is quoted without their written yes, and code cannot see one: say it in the product's own words, or ask the user to get the yes first.`;
  }
  return null;
}
