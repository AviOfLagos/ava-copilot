import { db, growthStore, shiftDay, teamChannelId, teamStore, utcDay } from '@extension/storage';
import type { GrowthStore, TeamChannel } from '@extension/storage';
import { whatChanged } from '../../rounds/plan';

/**
 * The channel list (docs/growth-team.md, Part 8, "Works by"): rank channels from the numbers, test the top three
 * cheaply for a week each, keep the one that moves the number. The model proposes channels and says who is
 * there; the ranking, the test weeks and the verdicts are arithmetic over the metrics store. A day with no
 * reading counts as unknown, never as 0.
 */

// How far back the ranking reads sign-ups
export const RANK_DAYS = 28;
// Channels tested at once, and a test's length
export const TESTS_AT_ONCE = 3;
export const TEST_DAYS = 7;
// A test still unread this many days after its week is dropped for want of numbers, freeing its place
export const VERDICT_GRACE_DAYS = 14;
const MAX_CHANNELS = 30;

export type ChannelStore = Pick<GrowthStore, 'metrics' | 'readings'>;

export interface RankedChannel {
  key: string;
  reach: string;
  costUsd: number;
  state: TeamChannel['state'];
  // Sign-ups a week from this channel over the read days, or null when it has none
  perWeek: number | null;
  readDays: number;
  verdict: string;
  // One of the top three channels not tested yet
  testNext: boolean;
}

/** A channel's key as sign-ups name it: lower case, plain. */
export const channelKey = (key: string) =>
  key
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.\-_]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** Sign-ups per channel and UTC day over a window, and the days that were read. */
async function signupsByChannel(workspaceId: string, from: string, to: string, store: ChannelStore) {
  const rows = await store.metrics(workspaceId, 'signups', from, to);
  const readDays = new Set(
    (await store.readings(workspaceId, 'signups', from, to))
      .filter(reading => reading.status === 'ok')
      .map(reading => reading.date),
  );
  const byChannel = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!row.channel || row.campaign || row.postId || !readDays.has(row.date)) continue;
    const key = channelKey(row.channel);
    const days = byChannel.get(key) ?? new Map<string, number>();
    days.set(row.date, (days.get(row.date) ?? 0) + row.value);
    byChannel.set(key, days);
  }
  return { byChannel, readDays };
}

const sumOver = (days: Map<string, number> | undefined, dates: string[]) =>
  dates.reduce((sum, date) => sum + (days?.get(date) ?? 0), 0);

const datesFrom = (from: string, count: number) => Array.from({ length: count }, (_, index) => shiftDay(from, index));

/**
 * The verdict on a finished test week: kept when its sign-ups beat the week before by the rounds' test (at least
 * 5 more and at least half again), dropped when they did not, and left testing when a day of either week was not
 * read.
 */
export function testVerdict(
  channel: Pick<TeamChannel, 'testFrom' | 'testTo'>,
  days: Map<string, number> | undefined,
  readDays: ReadonlySet<string>,
): { state: TeamChannel['state']; verdict: string } | null {
  if (!channel.testFrom || !channel.testTo) return null;
  const test = datesFrom(channel.testFrom, TEST_DAYS);
  const before = datesFrom(shiftDay(channel.testFrom, -TEST_DAYS), TEST_DAYS);
  if ([...test, ...before].some(date => !readDays.has(date))) {
    return {
      state: 'testing',
      verdict: 'No reading for every day of the test week and the week before: no verdict yet.',
    };
  }
  const during = sumOver(days, test);
  const earlier = sumOver(days, before);
  const change = whatChanged(during, [earlier]);
  return change.direction === 'up'
    ? { state: 'kept', verdict: `Kept: ${during} sign-ups in the test week against ${earlier} the week before.` }
    : { state: 'dropped', verdict: `Dropped: ${during} sign-ups in the test week against ${earlier} the week before.` };
}

/** Adds a channel idea to the list, or updates who is there and what a test costs. */
export async function addChannel(
  workspaceId: string,
  input: { key: string; reach: string; costUsd: number },
  now: number,
): Promise<{ ok: true; channel: TeamChannel } | { ok: false; why: string }> {
  const key = channelKey(input.key);
  if (!key) return { ok: false, why: 'Name the channel as sign-ups name it (its utm source), for example "reddit".' };
  const list = await teamStore.channels(workspaceId);
  const existing = list.find(channel => channel.key === key);
  if (!existing && list.length >= MAX_CHANNELS) {
    return { ok: false, why: `The list holds ${MAX_CHANNELS} channels; drop one before adding another.` };
  }
  const channel: TeamChannel = {
    ...(existing ?? {
      id: teamChannelId(workspaceId, key),
      workspaceId,
      key,
      state: 'idea' as const,
      testFrom: null,
      testTo: null,
      verdict: '',
    }),
    reach: input.reach.replace(/\s+/g, ' ').trim().slice(0, 200),
    costUsd: Math.max(0, Math.round(input.costUsd * 100) / 100),
    updatedAt: now,
  };
  await teamStore.saveChannel(channel);
  return { ok: true, channel };
}

/**
 * The ranked list: channels with sign-ups first, most a week first; then the rest, cheapest test first. Finished
 * tests get their verdict written down. The top three not tested yet are marked to test next.
 */
export async function rankChannels(
  workspaceId: string,
  now: number,
  store: ChannelStore = growthStore,
): Promise<RankedChannel[]> {
  const today = utcDay(now);
  const to = shiftDay(today, -1);
  const from = shiftDay(to, -(RANK_DAYS - 1));
  const list = await teamStore.channels(workspaceId);
  const earliestTest = list.reduce((earliest, channel) => {
    const start = channel.testFrom ? shiftDay(channel.testFrom, -TEST_DAYS) : null;
    return start && start < earliest ? start : earliest;
  }, from);
  const { byChannel, readDays } = await signupsByChannel(workspaceId, earliestTest, to, store);
  const window = datesFrom(from, RANK_DAYS).filter(date => readDays.has(date));

  // Finished test weeks get their verdict
  for (const channel of list) {
    if (channel.state !== 'testing' || !channel.testTo || channel.testTo >= today) continue;
    let verdict = testVerdict(channel, byChannel.get(channel.key), readDays);
    if (verdict?.state === 'testing' && shiftDay(channel.testTo, VERDICT_GRACE_DAYS) < today) {
      verdict = { state: 'dropped', verdict: 'Dropped: no reading for its test week, so it could not be judged.' };
    }
    if (verdict && (verdict.state !== channel.state || verdict.verdict !== channel.verdict)) {
      Object.assign(channel, verdict, { updatedAt: now });
      await teamStore.saveChannel(channel);
    }
  }

  const known = new Map(list.map(channel => [channel.key, channel]));
  // A channel sign-ups name that nobody listed is on the list too: its numbers are real
  for (const key of byChannel.keys()) {
    if (!known.has(key)) {
      known.set(key, {
        id: teamChannelId(workspaceId, key),
        workspaceId,
        key,
        reach: '',
        costUsd: 0,
        state: 'kept',
        testFrom: null,
        testTo: null,
        verdict: 'Already bringing sign-ups.',
        updatedAt: now,
      });
    }
  }

  const ranked: RankedChannel[] = [...known.values()].map(channel => {
    const days = byChannel.get(channel.key);
    const total = sumOver(days, window);
    // Measured only from days in the window: older test days do not make a 0
    const measured = window.some(date => days?.has(date));
    return {
      key: channel.key,
      reach: channel.reach,
      costUsd: channel.costUsd,
      state: channel.state,
      perWeek: measured ? Math.round((total / window.length) * 7 * 10) / 10 : null,
      readDays: window.length,
      verdict: channel.verdict,
      testNext: false,
    };
  });
  ranked.sort(
    (a, b) => (b.perWeek ?? -1) - (a.perWeek ?? -1) || a.costUsd - b.costUsd || a.key.localeCompare(b.key, 'en'),
  );
  const testing = ranked.filter(channel => channel.state === 'testing').length;
  let left = Math.max(0, TESTS_AT_ONCE - testing);
  for (const channel of ranked) {
    if (left === 0) break;
    if (channel.state === 'idea') {
      channel.testNext = true;
      left -= 1;
    }
  }
  return ranked;
}

/** The ranked list as the model reads it. */
export function rankedText(ranked: readonly RankedChannel[]): string {
  if (!ranked.length) return 'The channel list is empty. Add channels with add_channel: where the audience already is.';
  const lines = ranked.map((channel, index) => {
    const numbers =
      channel.perWeek === null
        ? 'no sign-ups read from it'
        : `${channel.perWeek} sign-ups a week over ${channel.readDays} read days`;
    const cost = channel.costUsd ? `$${channel.costUsd.toFixed(2)} to test` : 'free to test';
    const next = channel.testNext ? ' — test next' : '';
    return `${index + 1}. ${channel.key} (${channel.state}): ${numbers}; ${cost}${channel.reach ? `; ${channel.reach}` : ''}${channel.verdict ? `. ${channel.verdict}` : ''}${next}`;
  });
  return ['Channels, ranked by code from the sign-ups (a day with no reading is left out):', ...lines].join('\n');
}

/** Starts a channel's test week, once the user approved it. */
export async function startTest(workspaceId: string, key: string, now: number): Promise<string> {
  // One transaction: two yeses at once cannot start the same test twice, or a fourth test
  return db.transaction('rw', db.teamChannels, async () => {
    const list = await teamStore.channels(workspaceId);
    const channel = list.find(item => item.key === channelKey(key));
    if (!channel) return `The channel ${key} is no longer on the list.`;
    if (channel.state !== 'idea') return `The channel ${channel.key} is ${channel.state} already.`;
    if (list.filter(item => item.state === 'testing').length >= TESTS_AT_ONCE) {
      return `${TESTS_AT_ONCE} channels are being tested already, so ${channel.key} waits until one ends.`;
    }
    const testFrom = utcDay(now);
    const testTo = shiftDay(testFrom, TEST_DAYS - 1);
    await teamStore.saveChannel({ ...channel, state: 'testing', testFrom, testTo, verdict: '', updatedAt: now });
    return `The test of ${channel.key} runs from ${testFrom} to ${testTo}.`;
  });
}
