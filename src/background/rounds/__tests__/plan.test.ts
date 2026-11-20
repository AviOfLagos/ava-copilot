import { describe, expect, it } from 'vitest';
import { checkInDue, dueRound, localDay, localTime, whatChanged } from '../plan';
import type { CheckInFacts } from '../plan';
import { countKinds, readArgs, slackCounts } from '../slack';

// A local time on a fixed day
const at = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(2026, 10, 19, hours, minutes, 0).getTime();
};

describe('dueRound', () => {
  it('runs nothing before the first slot, and each round from its time on', () => {
    expect(dueRound(at('08:29'), {})).toBeNull();
    expect(dueRound(at('08:30'), {})).toEqual({ round: 'pulse', time: '08:30', skipped: [] });
    expect(dueRound(at('08:59'), { 'pulse|08:30': 1 })).toBeNull();
    expect(dueRound(at('09:01'), { 'pulse|08:30': 1 })).toEqual({ round: 'mail', time: '09:00', skipped: [] });
    expect(dueRound(at('12:00'), { 'pulse|08:30': 1, 'mail|09:00': 1 })).toMatchObject({ round: 'stuck' });
  });

  it('runs a missed round once when the browser opens later that day, never twice to catch up', () => {
    // Opened at 17:00: both pulse slots and both mail slots were missed
    const first = dueRound(at('17:00'), {});
    expect(first).toEqual({ round: 'stuck', time: '12:00', skipped: [] });
    const second = dueRound(at('17:05'), { 'stuck|12:00': 1 });
    expect(second).toEqual({ round: 'mail', time: '14:00', skipped: ['09:00'] });
    const third = dueRound(at('17:10'), { 'stuck|12:00': 1, 'mail|14:00': 1, 'mail|09:00': 0 });
    expect(third).toEqual({ round: 'pulse', time: '16:00', skipped: ['08:30'] });
    expect(
      dueRound(at('17:15'), { 'stuck|12:00': 1, 'mail|14:00': 1, 'mail|09:00': 0, 'pulse|16:00': 1, 'pulse|08:30': 0 }),
    ).toBeNull();
  });

  it('gives one round at a time, the one waiting longest first', () => {
    expect(dueRound(at('09:30'), {})).toMatchObject({ round: 'pulse', time: '08:30' });
  });

  it('reads the clock in local time', () => {
    expect(localTime(at('08:05'))).toBe('08:05');
    expect(localDay(at('08:05'))).toBe('2026-11-19');
  });
});

describe('checkInDue', () => {
  const facts = (over: Partial<CheckInFacts> = {}): CheckInFacts => ({
    now: at('13:00'),
    lastTaskAt: at('09:30'),
    startedAt: at('08:00'),
    offersToday: 0,
    lastOfferAt: 0,
    silenced: false,
    inMeeting: false,
    roundDue: false,
    ...over,
  });

  it('offers after three quiet hours between 09:00 and 18:00', () => {
    expect(checkInDue(facts())).toEqual({ due: true });
    expect(checkInDue(facts({ lastTaskAt: null }))).toEqual({ due: true });
  });

  it('waits out three hours from the last task, from the browser opening, and from the last offer', () => {
    expect(checkInDue(facts({ lastTaskAt: at('10:30') }))).toMatchObject({ due: false });
    expect(checkInDue(facts({ startedAt: at('11:00'), lastTaskAt: null }))).toMatchObject({ due: false });
    expect(checkInDue(facts({ lastOfferAt: at('12:00'), offersToday: 1 }))).toMatchObject({ due: false });
  });

  it('never offers outside the hours, more than twice, after "not today", in a meeting, or over a round', () => {
    expect(checkInDue(facts({ now: at('08:59'), lastTaskAt: null, startedAt: at('05:00') }))).toMatchObject({
      why: 'outside 09:00 to 18:00',
    });
    expect(checkInDue(facts({ now: at('18:00') }))).toMatchObject({ why: 'outside 09:00 to 18:00' });
    expect(checkInDue(facts({ offersToday: 2 }))).toMatchObject({ why: 'two offers already today' });
    expect(checkInDue(facts({ silenced: true }))).toMatchObject({ why: 'silenced until tomorrow' });
    expect(checkInDue(facts({ inMeeting: true }))).toMatchObject({ why: 'in a meeting' });
    expect(checkInDue(facts({ roundDue: true }))).toMatchObject({ why: 'a round goes first' });
  });
});

describe('whatChanged', () => {
  it('flags a change of at least 50% and at least 5, up or down', () => {
    expect(whatChanged(12, [4, 4, 4, 4, 4, 4, 4])).toMatchObject({ flagged: true, direction: 'up', average: 4 });
    expect(whatChanged(2, [10, 10, 10, 10, 10, 10, 10])).toMatchObject({ flagged: true, direction: 'down' });
  });

  it('does not flag a big percentage on small numbers, or a big number that is a small percentage', () => {
    // 1 → 4 is +300% but only 3 more
    expect(whatChanged(4, [1, 1, 1, 1, 1, 1, 1]).flagged).toBe(false);
    // 100 → 108 is 8 more but only +8%
    expect(whatChanged(108, [100, 100, 100, 100, 100, 100, 100]).flagged).toBe(false);
    // Exactly at both limits counts
    expect(whatChanged(15, [10, 10, 10, 10, 10, 10, 10]).flagged).toBe(true);
  });

  it('leaves days with no reading out of the average, and flags nothing with nothing to compare', () => {
    expect(whatChanged(12, [4, null, 4, null, null, null, null])).toMatchObject({ average: 4, flagged: true });
    expect(whatChanged(12, [null, null])).toEqual({ average: null, change: null, flagged: false, direction: null });
    expect(whatChanged(null, [4, 4]).flagged).toBe(false);
    // From nothing to five is worth a line
    expect(whatChanged(5, [0, 0, 0]).flagged).toBe(true);
  });
});

describe('Slack notification counts', () => {
  it('counts messages by the kind in square brackets, and not the source lines', () => {
    const text = [
      '[signup] someone at acme.test [source: producthunt]',
      '[signup] someone at beta.test [source: (direct)]',
      '[payment] plan changed · Acme · free → pro',
      '[access-request] Acme asked for more traces',
      'A person wrote: see [1] and [the docs](https://x.test)',
    ].join('\n');
    expect(countKinds(text)).toEqual({ signup: 2, payment: 1, access_request: 1 });
  });

  it('asks a read tool for one channel since a time, and refuses a tool that cannot say since when', () => {
    const schema = { properties: { channel_id: {}, oldest: {}, limit: {} } };
    expect(readArgs(schema, 'C0123', 1_800_000_000)).toEqual({ channel_id: 'C0123', oldest: '1800000000', limit: 200 });
    expect(readArgs({ properties: { channel_id: {} } }, 'C0123', 1)).toBeNull();
  });

  const profile = { workspaceId: 'acme', slackChannels: [{ name: '#acme-alerts', id: 'C0123' }] };
  const tool = (policy: 'read' | 'approve') => ({
    connector: { id: 'slack-1', name: 'Slack', url: 'https://mcp.slack.com/mcp' },
    fingerprint: { tool: 'slack_read_channel', inputSchema: { properties: { channel_id: {}, oldest: {} } } },
    policy,
  });
  const service = (tools: unknown[], text = '[signup] a\n[signup] b\n[feedback] c') => {
    const calls: unknown[] = [];
    return {
      calls,
      usableTools: async () => ({ tools, needSignIn: [] }) as never,
      prepare: async (...args: unknown[]) => {
        calls.push(args);
        return { connector: {}, fingerprint: {}, policy: 'read', args: {} } as never;
      },
      invoke: async () => ({ text, isError: false, truncated: false }),
    };
  };

  it('counts through a read tool the user set to run freely', async () => {
    const fake = service([tool('read')]);
    expect(await slackCounts(profile, 1_800_000_000_000, fake)).toEqual({
      ok: true,
      counts: { signup: 2, feedback: 1 },
      channels: 1,
    });
    expect(fake.calls[0]).toEqual([
      { workspaceId: 'acme' },
      'slack-1',
      'slack_read_channel',
      { channel_id: 'C0123', oldest: '1800000000' },
    ]);
  });

  it('says why nothing was counted, and never runs a tool that asks first', async () => {
    expect(await slackCounts(profile, 0, service([]))).toMatchObject({ ok: false, reason: 'not_connected' });
    const asks = service([tool('approve')]);
    expect(await slackCounts(profile, 0, asks)).toMatchObject({ ok: false, reason: 'asks_first' });
    expect(asks.calls).toHaveLength(0);
    expect(await slackCounts({ ...profile, slackChannels: [] }, 0, service([tool('read')]))).toMatchObject({
      ok: false,
      reason: 'no_channels',
    });
  });
});
