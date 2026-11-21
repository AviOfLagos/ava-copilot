import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]])),
        set: async (items: Record<string, unknown>) => Object.assign(data, items),
        onChanged: { addListener: () => undefined },
      },
    },
    i18n: { getMessage: (key: string) => key },
  });
});

const { db, emptyProductProfile, growthStore, productApiTokenRef } = await import('@extension/storage');
const { collectProduct, markNoticed, PRODUCT_METRICS } = await import('../collect');
const { createSutureClient, safeApiBase } = await import('../suture');
const { answerText, queryMetric, rangeProblem } = await import('../query');
const { makeLink, utmTag } = await import('../links');
import type { ProductProfile } from '@extension/storage';

const BASE = 'https://admin.example.test/api/agent/v1';
const TOKEN = 'tok-' + 'a'.repeat(40);
// Thursday 2026-11-19 10:00 UTC
const NOW = Date.parse('2026-11-19T10:00:00Z');
const TODAY = '2026-11-19';
const YESTERDAY = '2026-11-18';

const profile = (): ProductProfile => ({
  ...emptyProductProfile({ id: 'acme', name: 'Acme' }),
  url: 'https://acme.test',
  agentApi: { kind: 'suture-agent-v1', baseUrl: BASE },
});

// ── A stand-in for the product's API ──────────────────────────────────────────────────────────────

type Mode = 'ok' | 'off' | 'offline' | 'odd-signups' | 'signups-untracked';
const api = { mode: 'ok' as Mode, calls: [] as { url: string; auth: string | null; credentials?: string }[] };

const src = (label: string, campaign?: string) => ({ label, ...(campaign ? { utm_campaign: campaign } : {}) });
const windowed = (url: URL) => ({
  read_at: new Date(NOW).toISOString(),
  since: url.searchParams.get('since'),
  until: url.searchParams.get('until'),
});
const listOf = (url: URL, items: { source: ReturnType<typeof src> }[]) => {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.source.label, (counts.get(item.source.label) ?? 0) + 1);
  return {
    ...windowed(url),
    total: items.length,
    truncated: false,
    by_source: [...counts].map(([source, count]) => ({ source, count })),
    items,
  };
};
// What each day holds
const SIGNUPS: Record<string, { source: ReturnType<typeof src> }[]> = {
  [YESTERDAY]: [
    { source: src('producthunt', 'launch-week') },
    { source: src('producthunt', 'launch-week') },
    { source: src('x', 'thread-1') },
    { source: src('(direct)') },
    { source: src('(direct)') },
  ],
  [TODAY]: [{ source: src('x', 'thread-1') }, { source: src('(direct)') }],
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const auth = new Headers(init?.headers).get('authorization');
  api.calls.push({ url: url.pathname + url.search, auth, credentials: init?.credentials });
  if (api.mode === 'offline') throw new TypeError('Failed to fetch');
  if (api.mode === 'off') {
    return json(503, { error: { code: 'agent_api_off', message: 'The agent API is off here.' } });
  }
  if (auth !== `Bearer ${TOKEN}`) {
    return json(401, { error: { code: 'unauthorized', message: 'A valid agent token is required.' } });
  }
  const path = url.pathname.replace('/api/agent/v1', '');
  const day = url.searchParams.get('since') ?? '';
  switch (path) {
    case '':
      return json(200, { name: 'suture-agent-api', version: 1, read_at: new Date(NOW).toISOString() });
    case '/signups':
      if (api.mode === 'odd-signups') return json(200, { signups: 7 });
      if (api.mode === 'signups-untracked') {
        return json(200, {
          ...windowed(url),
          available: false,
          total: null,
          truncated: false,
          by_source: [],
          items: [],
        });
      }
      return json(200, { ...listOf(url, SIGNUPS[day] ?? []), available: true });
    case '/waitlist':
      return json(200, listOf(url, day === YESTERDAY ? [{ source: src('reddit') }] : []));
    case '/access-requests':
    case '/feedback':
      return json(200, listOf(url, []));
    case '/spend':
      return json(200, { ...windowed(url), total_usd: day === YESTERDAY ? 1.25 : 0, truncated: false, items: [] });
    case '/payments':
      return json(200, {
        ...windowed(url),
        available: false,
        reason: 'payments_not_recorded',
        total: null,
        items: [],
        paid_orgs: [{ org_id: 'o1', name: 'One', plan: 'pro', source: src('x') }],
      });
    case '/orgs':
      return json(200, {
        read_at: new Date(NOW).toISOString(),
        total: 9,
        truncated: false,
        active_7d: 4,
        by_plan: [
          { plan: 'free', count: 8 },
          { plan: 'pro', count: 1 },
        ],
        by_source: [],
        items: [],
      });
    default:
      return json(404, { error: { code: 'not_allowed', message: 'No.' } });
  }
}) as typeof fetch;

const deps = (token: string | null = TOKEN) => ({
  now: () => NOW,
  token: async () => token,
  client: (baseUrl: string, value: string) => createSutureClient(baseUrl, value, fakeFetch),
});
/** Collects, and marks a notice as delivered the way the Inbox step does. */
const told = async () => {
  const outcome = await collectProduct(profile(), deps());
  if (outcome?.notice) await markNoticed('acme', 'product', outcome.notice.reason);
  return outcome;
};
const ask = (metric: string, from = YESTERDAY, to = TODAY, by?: 'channel' | 'campaign') =>
  queryMetric(growthStore, { productId: 'acme', metric, from, to, by });

beforeEach(async () => {
  api.mode = 'ok';
  api.calls = [];
  await Promise.all([
    db.growthMetrics.clear(),
    db.growthReadings.clear(),
    db.growthSources.clear(),
    db.growthLinks.clear(),
  ]);
});

describe('the product collector', () => {
  it("reads yesterday's and today's numbers, with where the sign-ups came from", async () => {
    const outcome = await collectProduct(profile(), deps());
    expect(outcome).toMatchObject({ connected: true, notice: null });
    expect(outcome!.read).toEqual(
      expect.arrayContaining(['signups', 'waitlist', 'feedback', 'orgs', 'active_orgs', 'paid_orgs']),
    );

    const yesterday = await ask('signups', YESTERDAY, YESTERDAY, 'channel');
    expect(yesterday.total).toBe(5);
    expect(yesterday.parts).toEqual([
      { name: '(direct)', value: 2 },
      { name: 'producthunt', value: 2 },
      { name: 'x', value: 1 },
    ]);
    expect((await ask('signups', YESTERDAY, TODAY, 'campaign')).parts).toEqual([
      { name: 'launch-week', value: 2 },
      { name: 'thread-1', value: 2 },
    ]);
    expect((await ask('signups')).total).toBe(7);
    expect((await ask('waitlist')).total).toBe(1);
    // A day that was read and had none is a true zero
    expect((await ask('feedback', TODAY, TODAY)).total).toBe(0);
    expect((await ask('active_orgs', TODAY, TODAY)).total).toBe(4);
    expect((await ask('paid_orgs', TODAY, TODAY)).total).toBe(1);
    expect((await ask('spend_usd', YESTERDAY, YESTERDAY)).total).toBe(1.25);
    expect(await growthStore.sourceState('acme', 'product')).toMatchObject({ status: 'connected', lastOkAt: NOW });
  });

  it('sends the token as a bearer header and never the browser cookies', async () => {
    await collectProduct(profile(), deps());
    expect(api.calls.length).toBeGreaterThan(5);
    expect(api.calls.every(call => call.auth === `Bearer ${TOKEN}` && call.credentials === 'omit')).toBe(true);
    expect(api.calls.some(call => call.url.includes(TOKEN))).toBe(false);
  });

  it.each([
    ['off', TOKEN, 'agent_api_off'],
    ['ok', 'wrong-' + 'b'.repeat(40), 'unauthorized'],
    ['offline', TOKEN, 'unreachable'],
    ['ok', null, 'no_token'],
  ] as const)(
    'is "not connected" with the reason, never zero, when the API is %s (token %#)',
    async (mode, token, reason) => {
      api.mode = mode;
      const outcome = await collectProduct(profile(), deps(token));
      expect(outcome).toMatchObject({ connected: false, reason, notice: { reason } });
      expect(await db.growthMetrics.count()).toBe(0);
      for (const metric of PRODUCT_METRICS) {
        const answer = await ask(metric, TODAY, TODAY);
        expect(answer.total).toBeNull();
        expect(answer.byDay[0]).toMatchObject({ value: null, reason });
      }
      const text = answerText(await ask('signups'), 'Acme');
      expect(text).toMatch(/^Acme · signups · 2026-11-18 to 2026-11-19 \(UTC days\)\nNot connected: /);
      expect(text).toContain('Do not say 0');
      expect(text).not.toMatch(/Total/);
      // One request is enough to know: nothing else is asked of an API that is off
      if (mode === 'off') expect(api.calls).toHaveLength(1);
      if (token === null) expect(api.calls).toHaveLength(0);
    },
  );

  it('tells the user once per failure, and again only after it worked or for another reason', async () => {
    api.mode = 'off';
    expect((await told())?.notice).toMatchObject({ reason: 'agent_api_off' });
    expect((await told())?.notice).toBeNull();
    api.mode = 'offline';
    expect((await told())?.notice).toMatchObject({ reason: 'unreachable' });
    api.mode = 'ok';
    expect((await told())?.notice).toBeNull();
    api.mode = 'off';
    expect((await told())?.notice).toMatchObject({ reason: 'agent_api_off' });
  });

  it('keeps a number that was read when a later read fails, and says when it was read', async () => {
    await collectProduct(profile(), deps());
    api.mode = 'off';
    await collectProduct(profile(), { ...deps(), now: () => NOW + 3_600_000 });
    const answer = await ask('signups');
    expect(answer.total).toBe(7);
    expect(answer.readAt).toEqual({ newest: NOW, oldest: NOW });
    expect(answer.source).toMatchObject({ status: 'not_connected', reason: 'agent_api_off', lastOkAt: NOW });
  });

  it('reads an answer in a shape it does not know as "no reading", not as a number, and says so once', async () => {
    api.mode = 'odd-signups';
    const outcome = await collectProduct(profile(), deps());
    expect(outcome).toMatchObject({ connected: true, notice: { reason: 'unexpected_shape' } });
    expect((await ask('signups')).total).toBeNull();
    expect((await ask('signups')).byDay[0]).toMatchObject({ value: null, reason: 'unexpected_shape' });
    // The other numbers are still read
    expect((await ask('waitlist')).total).toBe(1);
    await markNoticed('acme', 'product', 'unexpected_shape');
    expect((await collectProduct(profile(), deps()))?.notice).toBeNull();
  });

  it('takes the product at its word when it says it has no reading', async () => {
    api.mode = 'signups-untracked';
    const outcome = await collectProduct(profile(), deps());
    expect((await ask('signups')).total).toBeNull();
    expect((await ask('signups')).byDay[0]).toMatchObject({ reason: 'not_available' });
    // Payments are never recorded by this product: no number, and no alarm either
    expect((await ask('payments')).total).toBeNull();
    expect(answerText(await ask('payments'), 'Acme')).toContain('paid_orgs');
    // Sign-ups that stopped being tracked are worth one notice; payments, never recorded, are not
    expect(outcome?.notice).toMatchObject({ reason: 'not_available' });
    api.mode = 'ok';
    expect((await told())?.notice).toBeNull();
  });

  it('reads nothing for a product with no API, and sends no token to an address that is not safe', async () => {
    expect(await collectProduct({ ...profile(), agentApi: null }, deps())).toBeNull();
    expect(safeApiBase('http://admin.example.test/api')).toBeNull();
    expect(safeApiBase('https://user:pw@admin.example.test/api')).toBeNull();
    expect(safeApiBase('http://127.0.0.1:8080/api')?.host).toBe('127.0.0.1:8080');
    const outcome = await collectProduct(
      { ...profile(), agentApi: { kind: 'suture-agent-v1', baseUrl: 'http://admin.example.test/api/agent/v1' } },
      deps(),
    );
    expect(outcome).toMatchObject({ connected: false, reason: 'not_set' });
    expect(api.calls).toHaveLength(0);
  });
});

describe('after review: what a number is, and is not', () => {
  it('never adds up a number that says how things stand: a week of 9 orgs is 9 orgs', async () => {
    const base = { productId: 'acme', source: 'product' as const, metric: 'orgs', ok: true as const };
    await growthStore.record({ ...base, date: '2026-11-17', total: 8, readAt: NOW - 2 * 86_400_000 });
    await growthStore.record({ ...base, date: YESTERDAY, total: 9, readAt: NOW - 86_400_000 });
    await growthStore.record({ ...base, date: TODAY, total: 9, readAt: NOW });
    const answer = await ask('orgs', '2026-11-17', TODAY);
    expect(answer).toMatchObject({ total: 9, latestOn: TODAY });
    const text = answerText(answer, 'Acme');
    expect(text).toContain('Latest: 9 (as it stood on 2026-11-19)');
    expect(text).not.toContain('Total');
  });

  it('says a day read before it was over is the count so far', async () => {
    await collectProduct(profile(), deps());
    const answer = await ask('signups');
    // Yesterday was read after it ended; today at 10:00
    expect(answer.unfinished).toEqual([TODAY]);
    expect(answerText(answer, 'Acme')).toContain('Not final: 2026-11-19 was read before the day was over');
  });

  it('reads a day again that was read before it was over, once the browser is back days later', async () => {
    await collectProduct(profile(), deps());
    api.calls = [];
    // Three days on: the 19th was last read at 10:00, so its number is from noon of a day long over
    const later = NOW + 3 * 86_400_000;
    await collectProduct(profile(), { ...deps(), now: () => later });
    const asked = api.calls.filter(call => call.url.startsWith('/api/agent/v1/signups')).map(call => call.url);
    expect(asked.some(url => url.includes('since=2026-11-19'))).toBe(true);
    expect((await ask('signups', TODAY, TODAY)).unfinished).toEqual([]);
  });

  it('does not let a list cut at the row limit replace a whole one read earlier', async () => {
    const base = {
      productId: 'acme',
      source: 'product' as const,
      metric: 'waitlist',
      date: YESTERDAY,
      ok: true as const,
    };
    await growthStore.record({ ...base, total: 620, readAt: NOW });
    await growthStore.record({ ...base, total: 500, partial: true, readAt: NOW + 1 });
    expect((await ask('waitlist', YESTERDAY, YESTERDAY)).total).toBe(620);
  });

  it('keeps parts apart whatever characters a visitor put in their names, and drops a part with no name', async () => {
    await growthStore.record({
      productId: 'acme',
      source: 'product',
      metric: 'signups',
      date: YESTERDAY,
      ok: true,
      total: 6,
      byChannel: [
        { channel: '|b', value: 1 },
        { channel: 'a|', value: 2 },
        { channel: '', value: 3 },
      ],
      byCampaign: [{ campaign: 'b|', value: 4 }],
      readAt: NOW,
    });
    const answer = await ask('signups', YESTERDAY, YESTERDAY, 'channel');
    expect(answer.total).toBe(6);
    expect(answer.parts).toEqual([
      { name: 'a|', value: 2 },
      { name: '|b', value: 1 },
    ]);
  });

  it('calls only the API\'s own "off" answer off: a 503 page from the host is a failure, not a missing token', async () => {
    const page = (async () => new Response('<html>Service Unavailable</html>', { status: 503 })) as typeof fetch;
    const client = createSutureClient(BASE, TOKEN, page);
    expect(await client.check()).toMatchObject({ ok: false, reason: 'failed' });
    const bare = (async () => json(503, { error: { code: 'agent_api_off' } })) as typeof fetch;
    expect(await createSutureClient(BASE, TOKEN, bare).check()).toMatchObject({ ok: false, reason: 'agent_api_off' });
  });

  it('refuses to send a token with a line break in it, and drops anything after "?" in the address', async () => {
    const outcome = await collectProduct(profile(), deps(`${TOKEN}\n`));
    expect(outcome).toMatchObject({ connected: false, reason: 'unauthorized' });
    expect(api.calls).toHaveLength(0);
    expect(safeApiBase('https://admin.example.test/api/agent/v1?x=1#frag')?.href).toBe(
      'https://admin.example.test/api/agent/v1',
    );
  });

  it('tells again when the notice could not be delivered: it is marked as told only once it was', async () => {
    api.mode = 'off';
    expect((await collectProduct(profile(), deps()))?.notice).toMatchObject({ reason: 'agent_api_off' });
    // The Inbox refused it, so nothing marked it: the next run tries again
    expect((await collectProduct(profile(), deps()))?.notice).toMatchObject({ reason: 'agent_api_off' });
    await markNoticed('acme', 'product', 'agent_api_off');
    expect((await collectProduct(profile(), deps()))?.notice).toBeNull();
  });

  it('says so once when the product stops tracking sign-ups, and stays quiet about payments', async () => {
    api.mode = 'signups-untracked';
    expect((await collectProduct(profile(), deps()))?.notice).toMatchObject({ reason: 'not_available' });
  });

  it('keeps a token under the host it was saved for', () => {
    expect(productApiTokenRef('acme', BASE)).toBe('product-api:acme@admin.example.test');
    expect(productApiTokenRef('acme', 'https://evil.test/api')).not.toBe(productApiTokenRef('acme', BASE));
  });
});

describe('metrics answers', () => {
  it('says which days have no reading and leaves them out of the total', async () => {
    await collectProduct(profile(), deps());
    const answer = await ask('signups', '2026-11-16', TODAY);
    expect(answer).toMatchObject({ total: 7, daysRead: 2, daysAsked: 4 });
    const text = answerText(answer, 'Acme');
    expect(text).toContain('Total: 7 over 2 of 4 days');
    expect(text).toContain('Read: 2026-11-19 10:00 UTC');
    expect(text).toContain('By day: 2026-11-16 no reading; 2026-11-17 no reading; 2026-11-18 5; 2026-11-19 2');
    expect(text).toContain('No reading for 2026-11-16 to 2026-11-17: nothing read it');
    expect(text).toContain('A day with no reading is not a zero');
  });

  it('has no number at all for a metric nobody reads', async () => {
    const answer = await ask('revenue');
    expect(answer.total).toBeNull();
    expect(answerText(answer, 'Acme')).toMatch(/No reading: Nothing has read this metric yet\./);
  });

  it('checks the range', () => {
    expect(rangeProblem('2026-11-18', '2026-11-19')).toBeNull();
    expect(rangeProblem('2026-11-19', '2026-11-18')).toMatch(/after/);
    expect(rangeProblem('yesterday', '2026-11-18')).toMatch(/YYYY-MM-DD/);
    expect(rangeProblem('2026-01-01', '2026-11-18')).toMatch(/at most 92 days/);
  });
});

describe('make_link', () => {
  const acme = { url: 'https://acme.test', name: 'Acme' };

  it('adds the three tags to a link to the product, the same way every time', () => {
    const made = makeLink(acme, {
      url: 'https://acme.test/pricing?ref=x',
      source: 'X',
      medium: 'Social',
      campaign: 'Launch Week!',
    });
    expect(made).toMatchObject({
      ok: true,
      url: 'https://acme.test/pricing?ref=x&utm_source=x&utm_medium=social&utm_campaign=launch-week',
      target: 'https://acme.test/pricing?ref=x',
    });
    expect(utmTag('  Product Hunt / Day 1 ')).toBe('product-hunt-day-1');
  });

  it('replaces tags that are already there instead of doubling them', () => {
    const made = makeLink(acme, {
      url: 'https://www.acme.test/?utm_source=old&utm_campaign=old',
      source: 'reddit',
      medium: 'community',
      campaign: 'ama',
    });
    expect(made.ok && made.url).toBe('https://www.acme.test/?utm_source=reddit&utm_campaign=ama&utm_medium=community');
  });

  it('refuses another site, a profile with no site, and an empty tag', () => {
    const tags = { source: 'x', medium: 'social', campaign: 'c' };
    expect(makeLink(acme, { url: 'https://evil.test/acme.test', ...tags })).toMatchObject({ ok: false });
    expect(makeLink(acme, { url: 'https://notacme.test/', ...tags })).toMatchObject({ ok: false });
    expect(makeLink(acme, { url: 'javascript:alert(1)', ...tags })).toMatchObject({ ok: false });
    expect(makeLink({ url: '', name: 'Acme' }, { url: 'https://acme.test/', ...tags })).toMatchObject({ ok: false });
    expect(makeLink(acme, { url: 'https://acme.test/', ...tags, campaign: '!!!' })).toMatchObject({ ok: false });
    expect(makeLink(acme, { url: 'https://app.acme.test/signup', ...tags })).toMatchObject({ ok: true });
  });
});
