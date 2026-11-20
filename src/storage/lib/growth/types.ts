/**
 * The numbers the growth agents work from (docs/growth-team.md, Part 7). Collected by plain code on a schedule,
 * never by a model, and read by agents through `metrics_query` only.
 *
 * Three kinds of record:
 * - a metric row holds a number that was really read;
 * - a reading says, for one metric on one day, whether it was read ('ok') or not ('none', with why). A day with
 *   no 'ok' reading has no number: it is "no reading", never 0;
 * - a source's state says whether its collector can reach what it reads ("not connected", with why).
 */

export type GrowthSource = 'product' | 'social' | 'email' | 'slack' | 'links';
export const GROWTH_SOURCES: GrowthSource[] = ['product', 'social', 'email', 'slack', 'links'];

export interface GrowthMetric {
  // Made from the product, day, source, metric, channel, campaign and post: reading the same thing again replaces it
  id: string;
  // The workspace whose product it is (one product per workspace)
  productId: string;
  // The UTC day the number covers, YYYY-MM-DD
  date: string;
  source: GrowthSource;
  // "signups", "waitlist", "feedback", "active_orgs", …
  metric: string;
  value: number;
  // Where it came from (a sign-up's source label), when the number is one part of a day's total. A row with no
  // channel, campaign or post is the day's total.
  channel?: string;
  campaign?: string;
  postId?: string;
  readAt: number;
}

// Why a number could not be read. Stable words, so code can tell them apart; `detail` holds the sentence.
export type NoReadingReason =
  // Nothing is set up to read it: no address, or no token in the vault
  | 'not_set'
  | 'no_token'
  // The product's API is switched off on its side (503 agent_api_off)
  | 'agent_api_off'
  // The token was refused (401)
  | 'unauthorized'
  // No answer: offline, DNS, timeout
  | 'unreachable'
  // An answer that was not what the collector expects: it is not read as numbers
  | 'unexpected_shape'
  // The product itself says it cannot report this (sign-up tracking off, payments not recorded)
  | 'not_available'
  // Any other refusal, with the status in `detail`
  | 'failed'
  // No collector reads this source yet
  | 'no_collector';

export interface GrowthReading {
  // productId|source|metric|date
  id: string;
  productId: string;
  source: GrowthSource;
  metric: string;
  date: string;
  status: 'ok' | 'none';
  reason: NoReadingReason | null;
  detail: string | null;
  // The list was cut at the product's row limit: the number is "at least" this
  partial?: boolean;
  readAt: number;
}

export interface GrowthSourceState {
  // productId|source
  id: string;
  productId: string;
  source: GrowthSource;
  status: 'connected' | 'not_connected';
  reason: NoReadingReason | null;
  detail: string | null;
  checkedAt: number;
  // The last time a read went through; null when none ever did
  lastOkAt: number | null;
  // The reason the user was last told about, so one failure makes one notice, not one per try
  noticed: NoReadingReason | null;
}

/** A link an agent made with `make_link`: where it points and how it is tagged. */
export interface GrowthLink {
  // productId|url (the tagged address): making the same link again gives the same record
  id: string;
  productId: string;
  url: string;
  target: string;
  source: string;
  medium: string;
  campaign: string;
  createdAt: number;
  // The chat that made it, if any
  threadId: string | null;
}

export const metricId = (
  row: Pick<GrowthMetric, 'productId' | 'date' | 'source' | 'metric' | 'channel' | 'campaign' | 'postId'>,
) =>
  // As JSON, not joined by a mark: a channel's name is a visitor's words and may hold any character
  JSON.stringify([
    row.productId,
    row.date,
    row.source,
    row.metric,
    row.channel ?? null,
    row.campaign ?? null,
    row.postId ?? null,
  ]);

export const readingId = (row: Pick<GrowthReading, 'productId' | 'source' | 'metric' | 'date'>) =>
  [row.productId, row.source, row.metric, row.date].join('|');

export const sourceStateId = (productId: string, source: GrowthSource) => `${productId}|${source}`;

/** When a UTC day ends: a number read before this is the day so far, not the day. */
export const dayEnd = (day: string): number => Date.parse(`${day}T00:00:00Z`) + 86_400_000;

/** The UTC day of a moment, YYYY-MM-DD. */
export const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** The UTC day `days` after (or, negative, before) a day. */
export function shiftDay(day: string, days: number): string {
  return utcDay(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000);
}
