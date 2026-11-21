import { z } from 'zod';
import type { NoReadingReason } from '@extension/storage';

/**
 * A client for the Suture agent API (`AviOfLagos/suture`, docs/API.md, "Agent API"): the reads only. It lives
 * on the product's admin console at `<origin>/api/agent/v1` and takes `Authorization: Bearer <token>`.
 *
 * What it must never do is turn a failed or odd answer into a number. Every answer is checked against the shape
 * the API documents; anything else is "no reading" with the reason. `total: null` (the API's own "no reading")
 * stays null.
 *
 * Where the live API differs from Part 13 of docs/growth-team.md, the API wins:
 * - no emails, names or user ids come back, only counts and sources;
 * - `/signups` may say `available: false`; `/payments` always does (Suture keeps no payment records): the count
 *   of orgs on a paid plan (`paid_orgs`) is read instead, and payments stay "no reading";
 * - `/spend` is Suture's cost to serve, not revenue.
 */

const source = z.object({ label: z.string(), utm_campaign: z.string().optional() }).passthrough();
const bySource = z.array(z.object({ source: z.string(), count: z.number().int().nonnegative() }));
const item = z.object({ source }).passthrough();
// The window is echoed back, but only `read_at` is needed here
const windowed = { read_at: z.string(), since: z.string().optional(), until: z.string().optional() };

const listSchema = z
  .object({
    ...windowed,
    total: z.number().int().nonnegative(),
    truncated: z.boolean(),
    by_source: bySource,
    items: z.array(item),
  })
  .passthrough();

const signupsSchema = z
  .object({
    ...windowed,
    available: z.boolean(),
    total: z.number().int().nonnegative().nullable(),
    truncated: z.boolean(),
    by_source: bySource,
    items: z.array(item),
  })
  .passthrough();

const orgsSchema = z
  .object({
    read_at: z.string(),
    total: z.number().int().nonnegative(),
    truncated: z.boolean(),
    active_7d: z.number().int().nonnegative(),
    by_plan: z.array(z.object({ plan: z.string(), count: z.number().int().nonnegative() })),
  })
  .passthrough();

const paymentsSchema = z
  .object({
    ...windowed,
    available: z.boolean(),
    reason: z.string().optional(),
    total: z.number().nonnegative().nullable(),
    paid_orgs: z.array(z.object({ org_id: z.string() }).passthrough()).optional(),
  })
  .passthrough();

const spendSchema = z
  .object({ ...windowed, total_usd: z.number().nonnegative(), truncated: z.boolean() })
  .passthrough();

const rootSchema = z.object({ name: z.string(), version: z.number(), read_at: z.string() }).passthrough();

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string().optional() }) });

export interface ReadFailure {
  ok: false;
  reason: NoReadingReason;
  // A plain sentence saying what happened, with nothing secret in it
  detail: string;
}

export type Read<T> = { ok: true; value: T } | ReadFailure;

/** One metric's count for a window, as read. */
export interface Count {
  total: number;
  byChannel: { channel: string; value: number }[];
  byCampaign: { campaign: string; value: number }[];
  // The list was cut at the API's row limit: the total is "at least" this
  partial: boolean;
}

export interface SutureClient {
  /** A cheap first call: whether the API answers this token at all. */
  check(): Promise<Read<true>>;
  signups(day: string): Promise<Read<Count>>;
  waitlist(day: string): Promise<Read<Count>>;
  accessRequests(day: string): Promise<Read<Count>>;
  feedback(day: string): Promise<Read<Count>>;
  /** Suture's own spend on models for the day, in US dollars. */
  spend(day: string): Promise<Read<{ totalUsd: number; partial: boolean }>>;
  /** Orgs as they are now: all of them, and those active in the last 7 days. */
  orgs(): Promise<Read<{ total: number; active7d: number; partial: boolean }>>;
  /** Always "no reading" today: the reason the API gives, and the paid-org count it offers instead. */
  payments(day: string): Promise<Read<{ total: number | null; reason: string; paidOrgs: number | null }>>;
}

const TIMEOUT_MS = 20_000;

/** Whether an address is safe to send a token to: https, or plain http on this computer only (tests). */
export function safeApiBase(baseUrl: string): URL | null {
  try {
    const url = new URL(baseUrl.trim());
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.endsWith('.localhost');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    if (url.username || url.password) return null;
    // An address is a place, not a question: nothing after "?" or "#" is kept
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

function countBy(values: (string | undefined)[], key: 'channel' | 'campaign') {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].map(([name, value]) => ({ [key]: name, value })) as never;
}

function failureFor(status: number, body: unknown): ReadFailure {
  const parsed = errorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error.code : '';
  // Only the API's own word for it: a 503 page from the host is a failure, not a missing token
  if (status === 503 && code === 'agent_api_off') {
    return {
      ok: false,
      reason: 'agent_api_off',
      detail: "The product's agent API is switched off on its side (503 agent_api_off): no token is set there yet.",
    };
  }
  if (status === 401) {
    return {
      ok: false,
      reason: 'unauthorized',
      detail: 'The product refused the token (401): it is wrong or was changed.',
    };
  }
  return {
    ok: false,
    reason: 'failed',
    detail: `The product answered ${status}${code ? ` (${code.slice(0, 60)})` : ''}.`,
  };
}

/**
 * @param fetcher - `fetch`, or a stand-in for tests
 */
export function createSutureClient(baseUrl: string, token: string, fetcher: typeof fetch = fetch): SutureClient {
  const base = safeApiBase(baseUrl);

  // A token is letters, digits and a few marks: anything else (a line break from a careless paste) cannot be sent
  const sendable = /^[\x21-\x7e]+$/.test(token);

  async function get<S extends z.ZodType>(
    path: string,
    schema: S,
    query: Record<string, string> = {},
  ): Promise<Read<z.infer<S>>> {
    if (!base) {
      return {
        ok: false,
        reason: 'not_set',
        detail: 'The product API address is missing, or is not an https address.',
      };
    }
    if (!sendable) {
      return {
        ok: false,
        reason: 'unauthorized',
        detail: 'The saved token has a space or a line break in it: paste it again.',
      };
    }
    const url = new URL(base.href.replace(/\/+$/, '') + path);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await fetcher(url.href, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        // Never the browser's cookies: the token is the only identity
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return {
        ok: false,
        reason: 'unreachable',
        detail: `No answer from ${base.host}: offline, or the address is wrong.`,
      };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      // Cut off while the answer was still arriving: that is no answer, not an odd one
      if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        return { ok: false, reason: 'unreachable', detail: `${base.host} stopped answering part of the way through.` };
      }
      body = null;
    }
    if (!response.ok) return failureFor(response.status, body);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'unexpected_shape',
        detail: `${path || '/'} answered in a shape this collector does not know, so it was not read as numbers.`,
      };
    }
    return { ok: true, value: parsed.data };
  }

  const windowOf = (day: string) => ({ since: day, until: nextDay(day) });

  async function list(path: string, day: string): Promise<Read<Count>> {
    const read = await get(path, listSchema, windowOf(day));
    if (!read.ok) return read;
    const { total, truncated, by_source: sources, items } = read.value;
    return {
      ok: true,
      value: {
        total,
        byChannel: sources.map(row => ({ channel: row.source, value: row.count })),
        byCampaign: countBy(
          items.map(row => row.source.utm_campaign),
          'campaign',
        ),
        partial: truncated,
      },
    };
  }

  return {
    async check() {
      const read = await get('', rootSchema);
      return read.ok ? { ok: true, value: true } : read;
    },

    async signups(day) {
      const read = await get('/signups', signupsSchema, windowOf(day));
      if (!read.ok) return read;
      const { available, total, truncated, by_source: sources, items } = read.value;
      // The API's own "no reading": never a zero
      if (!available || total === null) {
        return { ok: false, reason: 'not_available', detail: 'The product does not track sign-ups for this window.' };
      }
      return {
        ok: true,
        value: {
          total,
          byChannel: sources.map(row => ({ channel: row.source, value: row.count })),
          byCampaign: countBy(
            items.map(row => row.source.utm_campaign),
            'campaign',
          ),
          partial: truncated,
        },
      };
    },

    waitlist: day => list('/waitlist', day),
    accessRequests: day => list('/access-requests', day),
    feedback: day => list('/feedback', day),

    async spend(day) {
      const read = await get('/spend', spendSchema, windowOf(day));
      if (!read.ok) return read;
      return { ok: true, value: { totalUsd: read.value.total_usd, partial: read.value.truncated } };
    },

    async orgs() {
      const read = await get('/orgs', orgsSchema);
      if (!read.ok) return read;
      const { total, active_7d: active7d, truncated } = read.value;
      return { ok: true, value: { total, active7d, partial: truncated } };
    },

    async payments(day) {
      const read = await get('/payments', paymentsSchema, windowOf(day));
      if (!read.ok) return read;
      const { available, total, reason, paid_orgs: paidOrgs } = read.value;
      return {
        ok: true,
        value: {
          total: available ? total : null,
          reason: reason ?? 'not_available',
          paidOrgs: paidOrgs ? paidOrgs.length : null,
        },
      };
    },
  };
}
