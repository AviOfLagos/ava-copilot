import { getSecret, growthStore, productApiTokenRef, shiftDay, utcDay } from '@extension/storage';
import type { DayReading, GrowthSource, GrowthStore, NoReadingReason, ProductProfile } from '@extension/storage';
import { createLogger } from '../log';
import { createSutureClient } from './suture';
import type { Count, Read, ReadFailure, SutureClient } from './suture';

/**
 * The product collector (docs/growth-team.md, Part 7): reads a product's own API for its numbers, with no model.
 *
 * Rules it keeps:
 * - a number is only recorded when it was read. A failed read is "no reading" with the reason, never 0;
 * - when the API cannot be reached at all (off, wrong token, offline), the source is "not connected" and every
 *   day asked for is "no reading" with that reason;
 * - one failure makes one notice: the next notice comes only after it worked again, or for another reason.
 */

const logger = createLogger('Growth');

export const PRODUCT_METRICS = [
  'signups',
  'waitlist',
  'access_requests',
  'feedback',
  'spend_usd',
  'payments',
  'orgs',
  'active_orgs',
  'paid_orgs',
] as const;

// Counted for each day; the rest are how things stand at the moment of the read
const DAILY: (typeof PRODUCT_METRICS)[number][] = [
  'signups',
  'waitlist',
  'access_requests',
  'feedback',
  'spend_usd',
  'payments',
];
const NOW_ONLY: (typeof PRODUCT_METRICS)[number][] = ['orgs', 'active_orgs', 'paid_orgs'];

export interface CollectOutcome {
  productId: string;
  source: GrowthSource;
  connected: boolean;
  reason: NoReadingReason | null;
  detail: string | null;
  // Set when this run should tell the user: the first time this reason is seen since it last worked
  notice: { reason: NoReadingReason; detail: string } | null;
  // Metrics whose read went through, and the ones that did not (with why)
  read: string[];
  missed: { metric: string; date: string; reason: NoReadingReason; detail: string }[];
}

export interface CollectDeps {
  store?: GrowthStore;
  now?: () => number;
  token?: (profile: ProductProfile) => Promise<string | null>;
  client?: (baseUrl: string, token: string) => SutureClient;
}

const failure = (reason: NoReadingReason, detail: string): ReadFailure => ({ ok: false, reason, detail });

/**
 * Reads one product's numbers for yesterday and today (UTC) and records them.
 *
 * @returns What was read and what was not; null when the product has no API to read
 */
export async function collectProduct(profile: ProductProfile, deps: CollectDeps = {}): Promise<CollectOutcome | null> {
  if (!profile.agentApi) return null;
  const store = deps.store ?? growthStore;
  const now = deps.now?.() ?? Date.now();
  const productId = profile.workspaceId;
  const today = utcDay(now);
  const days = [shiftDay(today, -1), today];
  const outcome: CollectOutcome = {
    productId,
    source: 'product',
    connected: false,
    reason: null,
    detail: null,
    notice: null,
    read: [],
    missed: [],
  };

  const record = async (metric: string, date: string, read: Read<Omit<Count, 'partial'> & { partial?: boolean }>) => {
    const base = { productId, source: 'product' as const, metric, date, readAt: now };
    const reading: DayReading = read.ok
      ? {
          ...base,
          ok: true,
          total: read.value.total,
          byChannel: read.value.byChannel,
          byCampaign: read.value.byCampaign,
          partial: read.value.partial,
        }
      : { ...base, ok: false, reason: read.reason, detail: read.detail };
    await store.record(reading);
    if (read.ok) {
      if (!outcome.read.includes(metric)) outcome.read.push(metric);
    } else {
      outcome.missed.push({ metric, date, reason: read.reason, detail: read.detail });
    }
  };
  const total = (value: number, partial = false): Read<Omit<Count, 'partial'> & { partial?: boolean }> => ({
    ok: true,
    value: { total: value, byChannel: [], byCampaign: [], partial },
  });

  // 1. Can it be reached at all?
  const token = await (deps.token ?? (item => getSecret(productApiTokenRef(item.workspaceId))))(profile).catch(
    () => null,
  );
  let down: ReadFailure | null = null;
  let client: SutureClient | null = null;
  if (!token) {
    down = failure('no_token', 'No token for the product API is saved in Ava yet.');
  } else {
    client = (deps.client ?? createSutureClient)(profile.agentApi.baseUrl, token);
    const check = await client.check();
    if (!check.ok) down = check;
  }

  if (down || !client) {
    const why = down ?? failure('failed', 'The product API could not be read.');
    for (const date of days) for (const metric of DAILY) await record(metric, date, why);
    for (const metric of NOW_ONLY) await record(metric, today, why);
    outcome.reason = why.reason;
    outcome.detail = why.detail;
  } else {
    // 2. Each metric on its own: one that fails does not take the others with it
    for (const date of days) {
      await record('signups', date, await client.signups(date));
      await record('waitlist', date, await client.waitlist(date));
      await record('access_requests', date, await client.accessRequests(date));
      await record('feedback', date, await client.feedback(date));
      const spend = await client.spend(date);
      await record('spend_usd', date, spend.ok ? total(spend.value.totalUsd, spend.value.partial) : spend);
      const payments = await client.payments(date);
      await record(
        'payments',
        date,
        !payments.ok
          ? payments
          : payments.value.total !== null
            ? total(payments.value.total)
            : failure(
                'not_available',
                `The product keeps no payment records (${payments.value.reason}). Read paid_orgs, the orgs on a paid plan now, instead.`,
              ),
      );
    }
    const orgs = await client.orgs();
    await record('orgs', today, orgs.ok ? total(orgs.value.total, orgs.value.partial) : orgs);
    await record('active_orgs', today, orgs.ok ? total(orgs.value.active7d, orgs.value.partial) : orgs);
    await record('paid_orgs', today, orgs.ok ? total(orgs.value.paid, orgs.value.partial) : orgs);
    outcome.connected = true;
  }

  // 3. The source's state, and whether the user should hear about it now. A product that answers but with one
  // read in a shape the collector does not know is a problem too: that number is "no reading" until it is fixed.
  // What the product itself cannot report (payments) is expected, and is no problem.
  const odd = outcome.missed.find(miss => miss.reason !== 'not_available');
  const problem = outcome.connected
    ? odd
      ? { reason: odd.reason, detail: `${odd.metric}: ${odd.detail}` }
      : null
    : { reason: outcome.reason ?? ('failed' as const), detail: outcome.detail ?? '' };
  const before = await store.sourceState(productId, 'product');
  if (problem && before?.noticed !== problem.reason) outcome.notice = problem;
  await store.setSourceState({
    productId,
    source: 'product',
    status: outcome.connected ? 'connected' : 'not_connected',
    reason: problem?.reason ?? null,
    detail: problem?.detail ?? null,
    checkedAt: now,
    lastOkAt: outcome.connected ? now : (before?.lastOkAt ?? null),
    // Working again clears it, so the next failure is told
    noticed: problem?.reason ?? null,
  });
  logger.info(
    `Collected ${productId}: ${outcome.connected ? `${outcome.read.length} metrics read` : `not connected (${outcome.reason})`}`,
  );
  return outcome;
}
