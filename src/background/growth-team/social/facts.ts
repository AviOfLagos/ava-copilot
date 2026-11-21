import { growthStore, shiftDay, utcDay } from '@extension/storage';
import type { GrowthStore, ProductProfile } from '@extension/storage';
import { PRODUCT_METRICS } from '../../growth/collect';

/**
 * No invented numbers or quotes (docs/growth-team.md, Part 8 and "Evals"): a post, reply or listing an agent
 * writes may state a number only when the product profile or the metrics store holds it, and may not quote
 * anyone, because a customer is never quoted without their written yes and code cannot see that yes. Plain code,
 * run by the queue on every agent draft before it reaches the Inbox.
 */

// How far back a number may come from: a week's and four weeks' totals, and the days in between
const FACT_DAYS = 35;
// Small counts ("3 things we learned") are words more than facts
const SMALL = 10;

export type FactStore = Pick<GrowthStore, 'metrics' | 'readings'>;

const add = (set: Set<number>, value: number | null | undefined) => {
  if (typeof value === 'number' && Number.isFinite(value)) set.add(Math.round(value * 100) / 100);
};

function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map(match => Number(match[0].replace(/,/g, '')));
}

/** The numbers a draft may state: from the profile, and from the metrics store over the last five weeks. */
export async function knownNumbers(
  profile: ProductProfile,
  now: number,
  store: FactStore = growthStore,
): Promise<Set<number>> {
  const known = new Set<number>();
  for (const text of [
    profile.pricing,
    profile.oneLiner,
    profile.problem,
    profile.postalAddress,
    ...profile.differentiators,
  ]) {
    for (const value of numbersIn(text ?? '')) add(known, value);
  }
  add(known, profile.budget?.totalUsd);
  add(known, profile.betaRule?.testersPerWeek);
  add(known, profile.betaRule?.days);
  add(known, profile.northStar?.weeklyTarget);

  const to = utcDay(now);
  const from = shiftDay(to, -(FACT_DAYS - 1));
  for (const metric of PRODUCT_METRICS) {
    const [rows, readings] = await Promise.all([
      store.metrics(profile.workspaceId, metric, from, to),
      store.readings(profile.workspaceId, metric, from, to),
    ]);
    const read = new Set(readings.filter(reading => reading.status === 'ok').map(reading => reading.date));
    // Totals per day and per split (channel, campaign, post), and their sums over the last 7 and 28 days
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
      for (const span of [7, 28, FACT_DAYS]) {
        // Ending today (so far) and ending yesterday: both are numbers an agent may have been told
        for (const end of [to, shiftDay(to, -1)]) {
          let sum = 0;
          for (let index = 0; index < span; index++) sum += days.get(shiftDay(end, -index)) ?? 0;
          add(known, sum);
        }
      }
    }
  }
  return known;
}

/** The numbers in a draft that nothing known holds. Links, handles, tags, years, times and small counts are not facts. */
export function inventedNumbers(text: string, known: ReadonlySet<number>): string[] {
  const plain = text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#][\w.-]+/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ');
  const found: string[] = [];
  for (const match of plain.matchAll(/(?<![\w.])\d[\d,]*(?:\.\d+)?(?![\w])/g)) {
    const value = Number(match[0].replace(/,/g, ''));
    if (!Number.isFinite(value) || value <= SMALL) continue;
    if (Number.isInteger(value) && value >= 1990 && value <= 2100) continue;
    if (known.has(Math.round(value * 100) / 100)) continue;
    if (!found.includes(match[0])) found.push(match[0]);
  }
  return found;
}

/** Passages in quotation marks of four words or more: someone's words, which need their written yes. */
export function quotesIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/["“«„]([^"”»“]{3,400})["”»“]/g)) {
    const words = match[1]!.trim().split(/\s+/).filter(Boolean);
    if (words.length >= 4) found.push(match[1]!.trim());
  }
  return found;
}

/** Why an agent's draft may not reach the Inbox as written, or null when it may. */
export function factRefusal(text: string, known: ReadonlySet<number>): string | null {
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
