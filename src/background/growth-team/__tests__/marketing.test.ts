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
const { draftFollowUp, draftOutreach, NEW_PEOPLE_PER_DAY, outreachFooter, stopContact, workingDaysBetween } =
  await import('../marketing/outreach');
const { addChannel, rankChannels, rankedText, startTest, testVerdict } = await import('../marketing/channels');
const { channelTestAgreed, proposeChannelTest } = await import('../marketing/actions');
const { answerItem, propose } = await import('../queue');

// Monday 23 November 2026, 09:00 local
const MONDAY = new Date(2026, 10, 23, 9).getTime();
const DAY = 24 * 60 * 60 * 1000;
const who = { workspaceId: 'suture', agentId: 'pmm', agentName: 'Product Marketing Manager' };

const suture = (over: Partial<ProductProfile> = {}): ProductProfile => ({
  ...emptyProductProfile({ id: 'suture', name: 'Suture' }),
  email: { from: 'hello@trysuture.com', replyTo: 'hello@trysuture.com', via: 'nexmail' },
  postalAddress: '1 Example Street, Lagos',
  ...over,
});

const first = (email: string, over = {}) => ({
  email,
  source: 'https://github.com/acme/evals/blob/main/README.md',
  why: 'You maintain an open-source eval runner for LLM agents.',
  subject: 'Your eval runner and failing traces',
  body: 'Hi, Suture turns a failing agent trace into an eval and a fix. Would a 10-minute look help your runner?',
  ...over,
});

beforeEach(async () => {
  for (const key of Object.keys(local)) delete local[key];
  await Promise.all(
    [db.inbox, db.teamItems, db.teamLedger, db.teamContacts, db.teamSuppressed, db.teamChannels].map(table =>
      table.clear(),
    ),
  );
  vi.stubEnv('VITE_SEED_PROFILE', '');
  await productStore.set({ items: {}, seeds: [] } as never);
  await productStore.save(suture());
});

describe('outreach drafts', () => {
  it('drafts a first email for approval, with the sender, the postal address, why and how to opt out', async () => {
    const result = await draftOutreach(suture(), who, first('ada@acme.dev'), { now: () => MONDAY });
    expect(result).toMatchObject({ state: 'drafted', missing: [] });
    const [item] = await teamStore.forWorkspace('suture');
    expect(item).toMatchObject({ action: 'outreach_email', target: 'ada@acme.dev', mode: 'batch', status: 'queued' });
    expect(item!.body).toContain('Suture · hello@trysuture.com');
    expect(item!.body).toContain('1 Example Street, Lagos');
    expect(item!.body).toContain('Why you are getting this: You maintain an open-source eval runner');
    expect(item!.body).toContain('Reply "stop"');
    expect(item!.why).toContain('found at https://github.com/acme/evals');
  });

  it('says "not set" for a sender or postal address nobody gave, and tells the agent to say so', async () => {
    const bare = suture({ email: null, postalAddress: '' });
    expect(outreachFooter(bare, 'why').text).toMatch(/sender: not set[\s\S]*Postal address: not set/);
    const result = await draftOutreach(bare, who, first('ada@acme.dev'), { now: () => MONDAY });
    expect(result).toMatchObject({
      state: 'drafted',
      missing: ['the sender address', 'the postal address'],
      text: expect.stringMatching(/cannot go out until the sender address and the postal address are set/),
    });
  });

  it('never writes to a suppressed address or a personal mailbox, and not twice to the same person', async () => {
    await stopContact('Bob@Acme.dev', 'unsubscribed', MONDAY);
    expect(await draftOutreach(suture(), who, first('bob@acme.dev'), { now: () => MONDAY })).toMatchObject({
      state: 'refused',
      why: expect.stringMatching(/asked not to be written to \(unsubscribed\)/),
    });
    expect(await draftOutreach(suture(), who, first('someone@gmail.com'), { now: () => MONDAY })).toMatchObject({
      state: 'refused',
      why: expect.stringMatching(/personal mailbox/),
    });
    await draftOutreach(suture(), who, first('ada@acme.dev'), { now: () => MONDAY });
    expect(await draftOutreach(suture(), who, first('ADA@acme.dev'), { now: () => MONDAY })).toMatchObject({
      state: 'refused',
      why: expect.stringMatching(/written to before/),
    });
    expect(await teamStore.forWorkspace('suture')).toHaveLength(1);
  });

  it('stops at 20 new people a day for one product', async () => {
    for (let index = 0; index < NEW_PEOPLE_PER_DAY; index++) {
      await teamStore.saveContact({
        id: `suture|p${index}@acme.dev`,
        workspaceId: 'suture',
        email: `p${index}@acme.dev`,
        source: 'https://acme.dev',
        why: 'x',
        firstAt: MONDAY - 60_000,
        followUps: 0,
        lastAt: MONDAY,
        itemId: null,
      });
    }
    expect(await draftOutreach(suture(), who, first('ada@acme.dev'), { now: () => MONDAY })).toMatchObject({
      state: 'refused',
      why: expect.stringMatching(/At most 20 new people a day/),
    });
    // Tomorrow is a new day
    expect((await draftOutreach(suture(), who, first('ada@acme.dev'), { now: () => MONDAY + DAY })).state).toBe(
      'drafted',
    );
  });

  it('allows one follow-up, 3 working days after the user approved the first email, then stops', async () => {
    // Thursday: the weekend does not count
    const thursday = MONDAY + 3 * DAY;
    const drafted = await draftOutreach(suture(), who, first('ada@acme.dev'), { now: () => thursday });
    const follow = { email: 'ada@acme.dev', subject: 'Following up', body: 'One more note, then I will leave it.' };
    expect(await draftFollowUp(suture(), who, follow, { now: () => thursday + 9 * DAY })).toMatchObject({
      state: 'refused',
      why: expect.stringMatching(/still waits for the user/),
    });
    await teamStore.decide(drafted.state === 'drafted' ? drafted.result.item.id : '', 'held', '', thursday);
    // The next Tuesday: Friday and Monday have passed
    expect(await draftFollowUp(suture(), who, follow, { now: () => thursday + 5 * DAY })).toMatchObject({
      state: 'refused',
      why: expect.stringMatching(/waits 3 working days after the first email; 2 have passed/),
    });
    expect((await draftFollowUp(suture(), who, follow, { now: () => thursday + 6 * DAY })).state).toBe('drafted');
    expect(await draftFollowUp(suture(), who, follow, { now: () => thursday + 9 * DAY })).toMatchObject({
      state: 'refused',
      why: expect.stringMatching(/had their one follow-up/),
    });
    expect(
      await draftFollowUp(suture(), who, { ...follow, email: 'eve@acme.dev' }, { now: () => thursday }),
    ).toMatchObject({ state: 'refused', why: expect.stringMatching(/needs a first email/) });
  });

  it('never follows up an email the user declined', async () => {
    const drafted = await draftOutreach(suture(), who, first('ada@acme.dev'), { now: () => MONDAY });
    await teamStore.decide(drafted.state === 'drafted' ? drafted.result.item.id : '', 'declined', '', MONDAY);
    const follow = { email: 'ada@acme.dev', subject: 'Following up', body: 'One more note.' };
    expect(await draftFollowUp(suture(), who, follow, { now: () => MONDAY + 14 * DAY })).toMatchObject({
      state: 'refused',
      why: expect.stringMatching(/did not go ahead/),
    });
  });

  it('keeps the address rules in the queue itself, in one form, whichever tool proposes', async () => {
    const email = (target: string) =>
      propose(
        { ...who, action: 'outreach_email', title: 'Hello', body: 'A note.', target, why: 'x' },
        { now: () => MONDAY },
      );
    await stopContact('bob+news@Acme.dev', 'unsubscribed', MONDAY);
    expect(await email('BOB@acme.dev')).toMatchObject({ state: 'refused', why: expect.stringMatching(/asked not to/) });
    expect(await email('bob+other@acme.dev')).toMatchObject({ state: 'refused' });
    for (const personal of ['ada@yahoo.co.uk', 'ada@hotmail.com.br', 'ada@gmx.net', 'ada@web.de', 'ada@pm.me']) {
      expect(await email(personal), personal).toMatchObject({
        state: 'refused',
        why: expect.stringMatching(/personal/),
      });
    }
    expect((await email('ada@acme.dev')).state).toBe('queued');
  });

  it('does not take a postal code in the footer for a phone number', async () => {
    const brazil = suture({ postalAddress: 'Av. Paulista 1000, 01310-100 São Paulo' });
    await productStore.save(brazil);
    expect((await draftOutreach(brazil, who, first('ada@acme.dev'), { now: () => MONDAY })).state).toBe('drafted');
  });

  it('does not carry out an email whose address was stopped while it waited', async () => {
    const drafted = await draftOutreach(suture(), who, first('ada@acme.dev'), { now: () => MONDAY });
    await stopContact('ada@acme.dev', 'replied', MONDAY);
    const item = await answerItem(drafted.state === 'drafted' ? drafted.result.item.id : '', true, {}, {});
    expect(item).toMatchObject({ status: 'failed', note: expect.stringMatching(/asked not to be written to/) });
  });

  it('counts working days, Monday to Friday', () => {
    const friday = MONDAY + 4 * DAY;
    expect(workingDaysBetween(friday, friday + 3 * DAY)).toBe(0);
    expect(workingDaysBetween(friday, friday + 4 * DAY)).toBe(1);
    expect(workingDaysBetween(MONDAY, MONDAY + 3 * DAY)).toBe(2);
  });
});

describe('the channel list', () => {
  const NOW = Date.parse('2026-11-23T09:00:00Z');
  const row = (date: string, channel: string, value: number): GrowthMetric => ({
    id: `${date}|${channel}`,
    productId: 'suture',
    date,
    source: 'product',
    metric: 'signups',
    value,
    channel,
    readAt: NOW,
  });
  const reading = (date: string, status: 'ok' | 'none' = 'ok'): GrowthReading => ({
    id: date,
    productId: 'suture',
    source: 'product',
    metric: 'signups',
    date,
    status,
    reason: null,
    detail: null,
    readAt: NOW,
  });
  const days = (from: string, count: number) =>
    Array.from({ length: count }, (_, index) => {
      const date = new Date(`${from}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + index);
      return date.toISOString().slice(0, 10);
    });
  const last28 = days('2026-10-26', 28);

  it('ranks channels by the sign-ups they brought, then untested ideas cheapest first, and marks three to test', async () => {
    for (const [key, cost] of [
      ['hn', 0],
      ['reddit', 0],
      ['producthunt', 0],
      ['ads', 200],
    ] as const) {
      await addChannel('suture', { key, reach: 'developers', costUsd: cost }, NOW);
    }
    const metrics = [...last28.map(date => row(date, 'x', 2)), ...last28.map(date => row(date, 'reddit', 1))];
    const ranked = await rankChannels('suture', NOW, {
      metrics: async () => metrics,
      readings: async () => last28.map(date => reading(date)),
    });
    expect(ranked.map(channel => [channel.key, channel.perWeek, channel.testNext])).toEqual([
      ['x', 14, false],
      ['reddit', 7, true],
      ['hn', null, true],
      ['producthunt', null, true],
      ['ads', null, false],
    ]);
    expect(rankedText(ranked)).toMatch(/1\. x \(kept\): 14 sign-ups a week over 28 read days/);
  });

  it('says nothing about a channel from days that were not read', async () => {
    const metrics = last28.map(date => row(date, 'x', 2));
    const ranked = await rankChannels('suture', NOW, {
      metrics: async () => metrics,
      readings: async () => last28.map(date => reading(date, 'none')),
    });
    expect(ranked).toEqual([]);
  });

  it('keeps a tested channel that moved the number and drops one that did not, after its week', () => {
    const read = new Set(days('2026-11-02', 14));
    const week = (values: number[]) => new Map(days('2026-11-02', 14).map((date, index) => [date, values[index]!]));
    const channel = { testFrom: '2026-11-09', testTo: '2026-11-15' };
    expect(testVerdict(channel, week([...Array(7).fill(1), ...Array(7).fill(3)]), read)).toMatchObject({
      state: 'kept',
      verdict: expect.stringContaining('21 sign-ups in the test week against 7'),
    });
    expect(testVerdict(channel, week(Array(14).fill(1)), read)?.state).toBe('dropped');
    read.delete('2026-11-12');
    expect(testVerdict(channel, week(Array(14).fill(1)), read)?.state).toBe('testing');
  });

  it('asks for a test only of a channel marked "test next", and the yes starts its week', async () => {
    const empty = { metrics: async () => [], readings: async () => [] };
    await addChannel('suture', { key: 'hn', reach: 'developers', costUsd: 0 }, NOW);
    const asked = await proposeChannelTest(
      suture(),
      who,
      { channel: 'HN', plan: 'Post a Show HN with the fix loop on Tuesday.' },
      { now: () => NOW, channelStore: empty },
    );
    expect(asked.state).toBe('queued');
    expect(
      await proposeChannelTest(
        suture(),
        who,
        { channel: 'tiktok', plan: 'x' },
        { now: () => NOW, channelStore: empty },
      ),
    ).toMatchObject({ state: 'refused', why: expect.stringMatching(/not on the channel list/) });
    const [item] = await teamStore.forWorkspace('suture');
    expect(item).toMatchObject({ action: 'new_channel', mode: 'always_ask', fields: { channel: 'hn' } });
    expect(await channelTestAgreed(item!, NOW)).toBe('The test of hn runs from 2026-11-23 to 2026-11-29.');
    expect((await teamStore.channels('suture'))[0]).toMatchObject({ state: 'testing', testFrom: '2026-11-23' });
    expect(await startTest('suture', 'hn', NOW)).toMatch(/testing already/);
  });

  it('may ask again after a decline, never twice at once, and runs at most three tests', async () => {
    const empty = { metrics: async () => [], readings: async () => [] };
    const ask = (channel: string) =>
      proposeChannelTest(suture(), who, { channel, plan: 'A week of posts.' }, { now: () => NOW, channelStore: empty });
    await addChannel('suture', { key: 'hn', reach: 'developers', costUsd: 0 }, NOW);
    const first = await ask('hn');
    expect(await ask('hn')).toMatchObject({ state: 'refused', why: expect.stringMatching(/already waits/) });
    await teamStore.decide(first.state === 'queued' ? first.item.id : '', 'declined', '', NOW);
    expect((await ask('hn')).state).toBe('queued');

    for (const key of ['a1', 'a2', 'a3', 'a4']) await addChannel('suture', { key, reach: 'x', costUsd: 0 }, NOW);
    for (const key of ['a1', 'a2', 'a3']) expect(await startTest('suture', key, NOW)).toMatch(/runs from/);
    expect(await startTest('suture', 'a4', NOW)).toMatch(/3 channels are being tested already/);
  });

  it('drops a test that stayed unread two weeks after its week', async () => {
    await addChannel('suture', { key: 'hn', reach: 'developers', costUsd: 0 }, NOW);
    await startTest('suture', 'hn', NOW);
    const later = NOW + 22 * 24 * 60 * 60 * 1000;
    const ranked = await rankChannels('suture', later, { metrics: async () => [], readings: async () => [] });
    expect(ranked[0]).toMatchObject({ key: 'hn', state: 'dropped', verdict: expect.stringMatching(/no reading/) });
  });
});
