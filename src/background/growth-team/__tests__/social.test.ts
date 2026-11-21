import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrowthMetric, GrowthReading, ProductProfile } from '@extension/storage';

const local: Record<string, unknown> = {};
vi.hoisted(() => {
  vi.stubGlobal('chrome', {
    i18n: { getMessage: (key: string, subs?: string | string[]) => [key, ...[subs ?? []].flat()].join('|') },
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in store()).map(k => [k, store()[k]])),
        set: async (items: Record<string, unknown>) => void Object.assign(store(), items),
        onChanged: { addListener: () => undefined },
      },
    },
  });
});
function store() {
  return local;
}

const { db, emptyProductProfile, productStore, teamStore } = await import('@extension/storage');
const { factRefusal, forgetShown, inventedNumbers, knownNumbers, quotesIn, rememberShown } =
  await import('../social/facts');
const { postResults, postResultsText } = await import('../social/posts');
const { socialDraftCheck } = await import('../social/actions');
const { propose, registerProposalCheck } = await import('../queue');

const NOW = Date.parse('2026-11-23T12:00:00Z');

const suture = (over: Partial<ProductProfile> = {}): ProductProfile => ({
  ...emptyProductProfile({ id: 'suture', name: 'Suture' }),
  pricing: 'Free during beta, then $49 a month',
  betaRule: { testersPerWeek: 5, days: 30, plan: 'pro' },
  ...over,
});

const row = (date: string, metric: string, value: number, extra: Partial<GrowthMetric> = {}): GrowthMetric => ({
  id: `${date}|${metric}|${extra.channel ?? ''}|${extra.postId ?? ''}`,
  productId: 'suture',
  date,
  source: 'product',
  metric,
  value,
  readAt: NOW,
  ...extra,
});
const reading = (date: string, metric: string, status: 'ok' | 'none' = 'ok'): GrowthReading => ({
  id: `${date}|${metric}`,
  productId: 'suture',
  source: 'product',
  metric,
  date,
  status,
  reason: null,
  detail: null,
  readAt: NOW,
});

// Sign-ups: 6 a day for the last 7 days, one post that brought 13; one day with no reading holds 999
const week = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'];
const facts = {
  metrics: async (_product: string, metric: string) =>
    metric === 'signups'
      ? [
          ...week.map(date => row(date, 'signups', 6)),
          row('2026-11-20', 'signups', 13, { postId: 'fix-loop-thread' }),
          row('2026-11-15', 'signups', 999),
        ]
      : [],
  readings: async (_product: string, metric: string) =>
    metric === 'signups'
      ? [...week.map(date => reading(date, 'signups')), reading('2026-11-15', 'signups', 'none')]
      : [],
};

beforeEach(async () => {
  for (const key of Object.keys(local)) delete local[key];
  await Promise.all([db.inbox, db.teamItems].map(table => table.clear()));
  vi.stubEnv('VITE_SEED_PROFILE', '');
  await productStore.set({ items: {}, seeds: [] } as never);
  await productStore.save(suture());
});

describe('no invented numbers or quotes', () => {
  it('knows the numbers of the profile and of the metrics store, never those of a day that was not read', async () => {
    const known = await knownNumbers(suture(), NOW, facts);
    for (const value of [49, 5, 30, 6, 13, 42]) expect(known.has(value), String(value)).toBe(true);
    expect(known.has(999)).toBe(false);
  });

  it('flags a number nothing holds, and lets links, handles, years, times and small counts through', () => {
    const known = new Set([42]);
    expect(inventedNumbers('42 sign-ups this week, up 300%', known)).toEqual(['300%']);
    expect(
      inventedNumbers('3 lessons from 2026 at 10:30, see https://x.com/a/status/1234567 by @dev_99 #build100', known),
    ).toEqual([]);
    expect(inventedNumbers('We now have 1,250 users', new Set([1250]))).toEqual([]);
  });

  it('flags a quote of four words or more, and not a short phrase in quotation marks', () => {
    expect(quotesIn('A customer said "this saved my whole week" yesterday')).toEqual(['this saved my whole week']);
    expect(quotesIn('We call it the “fix loop”.')).toEqual([]);
    expect(factRefusal('“Suture saved our launch day completely”', new Set())).toMatch(/quotes someone/);
  });

  it("refuses an agent's post with an invented number before the Inbox, and leaves the user's own chat alone", async () => {
    registerProposalCheck((proposal, profile, now) => socialDraftCheck(proposal, profile, now, facts));
    const draft = (agentId: string | null, body: string) =>
      propose(
        {
          workspaceId: 'suture',
          agentId,
          agentName: agentId ? 'Product Social Manager' : 'Ava',
          action: 'post',
          title: 'This week',
          body,
          target: 'x',
          why: "This week's experiment",
        },
        { now: () => NOW },
      );
    expect(await draft('social', '500 teams signed up this week.')).toMatchObject({
      state: 'refused',
      why: expect.stringMatching(/states "500", which neither the product profile nor metrics_query holds/),
    });
    expect((await draft('social', '42 people signed up this week; one thread brought 13.')).state).toBe('queued');
    // The user's own words, in their own chat, are theirs
    expect((await draft(null, '500 teams signed up this week.')).state).toBe('queued');
    expect(await teamStore.forWorkspace('suture')).toHaveLength(2);
  });
});

describe('numbers written the way people write them', () => {
  it('reads "12k", "1.5m" and "100x" as what they say, and accepts a rounded known number', () => {
    const known = new Set([12_345, 42]);
    expect(inventedNumbers('We passed 12k sign-ups', known)).toEqual([]);
    expect(inventedNumbers('We passed 250k sign-ups and grew 100x', known)).toEqual(['250k', '100x']);
    expect(inventedNumbers('1.5m teams', known)).toEqual(['1.5m']);
    expect(
      inventedNumbers('Now $49.00 a month, 42 a week, a 50ms reply, v2 and the 3rd release', new Set([49, 42])),
    ).toEqual([]);
  });

  it('checks "1.200" as twelve hundred, and lets "1.5" and "it\'s" through', () => {
    expect(inventedNumbers('1.200 teams use it', new Set())).toEqual(['1.200']);
    expect(inventedNumbers('1.200 teams use it', new Set([1200]))).toEqual([]);
    expect(inventedNumbers('1.250,50 euros', new Set([1250.5]))).toEqual([]);
    expect(inventedNumbers('Version 1.5 is out', new Set())).toEqual([]);
    expect(inventedNumbers('1.2.34 people', new Set())).toEqual(['1.2.34']);
  });

  it('knows a 14-day total, a whole month, the change on the week before, and what a tool showed', async () => {
    const rising = {
      metrics: async (_product: string, metric: string) =>
        metric === 'signups'
          ? [
              ...week.map(date => row(date, 'signups', 6)),
              ...['2026-11-09', '2026-11-10', '2026-11-11'].map(date => row(date, 'signups', 10)),
            ]
          : [],
      readings: async (_product: string, metric: string) =>
        metric === 'signups'
          ? [...week, '2026-11-09', '2026-11-10', '2026-11-11'].map(date => reading(date, 'signups'))
          : [],
    };
    forgetShown();
    rememberShown('suture', [317], NOW);
    const known = await knownNumbers(suture(), NOW, rising);
    // 72 over 14 days; 42 this week against 30 the week before is up 40%
    for (const value of [72, 317]) expect(known.has(value), String(value)).toBe(true);
    expect(known.percents?.has(40)).toBe(true);
    expect(inventedNumbers('40 teams', known)).toEqual(['40']);
    expect(inventedNumbers('Up 40% on last week, 72 in two weeks, 317 in all', known)).toEqual([]);
    expect(inventedNumbers('Up 55% on last week', known)).toEqual(['55%']);
    // A rise is never stated as a fall
    expect(inventedNumbers('Sign-ups fell 40% on last week', known)).toEqual(['40%']);
    // Shown numbers last a day
    expect((await knownNumbers(suture(), NOW + 25 * 60 * 60_000, rising)).has(317)).toBe(false);
  });

  it('finds quotes in single, curly and corner quotation marks and in Markdown quote lines', () => {
    expect(quotesIn("A user wrote 'this saved my whole week' to us")).toHaveLength(1);
    expect(quotesIn('A user wrote ‘this saved my whole week’ to us')).toHaveLength(1);
    expect(quotesIn('「this saved my whole week」')).toHaveLength(1);
    expect(quotesIn('> this saved my whole week\n\nThat is why we built it.')).toHaveLength(1);
    expect(quotesIn("It's the fix loop we've wanted, and it's free during beta.")).toEqual([]);
  });

  it("checks a routine's chat with no agent, and an outreach email as well as a post", async () => {
    registerProposalCheck((proposal, profile, now) => socialDraftCheck(proposal, profile, now, facts));
    const base = {
      workspaceId: 'suture',
      agentId: null,
      agentName: 'Ava',
      title: 'Hello',
      body: '500 teams use Suture.',
      why: 'test',
    } as const;
    expect((await propose({ ...base, automated: true, action: 'post', target: 'x' }, { now: () => NOW })).state).toBe(
      'refused',
    );
    expect(
      (
        await propose(
          { ...base, agentId: 'marketing', action: 'outreach_email', target: 'dev@someco.io' },
          { now: () => NOW },
        )
      ).state,
    ).toBe('refused');
  });
});

describe('what each post brought', () => {
  it('sums each post over the read days, and says "no reading" when there is none', async () => {
    const results = await postResults(suture(), NOW, facts);
    expect(results).toEqual([{ postId: 'fix-loop-thread', numbers: { signups: 13 }, readDays: 1 }]);
    expect(postResultsText(results)).toMatch(/fix-loop-thread: 13 signups \(1 days read\)/);
    expect(postResultsText([])).toMatch(/No reading for any post/);
  });
});
