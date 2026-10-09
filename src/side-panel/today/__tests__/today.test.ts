import { describe, expect, it } from 'vitest';
import { summarizeToday, topSites } from '../today';
import type { TodayInput } from '../today';

const DAY = new Date(2026, 9, 9, 0, 0, 0).getTime();
const at = (hour: number, minute = 0) => DAY + hour * 3_600_000 + minute * 60_000;

const base: TodayInput = {
  messages: [],
  threads: [
    { id: 't1', boundUrl: 'https://mail.google.com/mail/u/0' },
    { id: 't2', boundUrl: 'https://www.slack.com/x' },
  ],
  meetings: [],
  segments: [],
  costUsd: 0.41,
  approvedPrefix: 'Confirmed:',
  declinedPrefix: 'Cancelled:',
  dayStart: DAY,
  now: at(20),
};

describe('summarizeToday', () => {
  it('counts tasks by hour, steps by site, and finished tasks', () => {
    const today = summarizeToday({
      ...base,
      messages: [
        { threadId: 't1', actor: 'user', content: 'Draft replies', ts: at(9, 5) },
        { threadId: 't1', actor: 'planner', content: 'plan', ts: at(9, 6) },
        { threadId: 't1', actor: 'navigator', content: 'Clicking Compose', ts: at(9, 7) },
        { threadId: 't1', actor: 'navigator', content: 'done', ts: at(9, 8) },
        { threadId: 't1', actor: 'planner', content: 'Drafted.', ts: at(9, 9) },
        { threadId: 't2', actor: 'user', content: 'Post it', ts: at(14) },
        { threadId: 't2', actor: 'navigator', content: 'Typing', ts: at(14, 1) },
        { threadId: 't2', actor: 'navigator', content: 'Clicking Send', ts: at(14, 2) },
        { threadId: 't2', actor: 'system', content: 'Confirmed: Send', ts: at(14, 3) },
        { threadId: 't2', actor: 'system', content: 'Cancelled: Delete', ts: at(15) },
        // Yesterday does not count
        { threadId: 't2', actor: 'user', content: 'old', ts: DAY - 1000 },
      ],
    });
    expect(today.hours[9].tasks).toBe(1);
    expect(today.hours[14]).toMatchObject({ tasks: 1, held: 1 });
    expect(today.hours[15].held).toBe(1);
    expect(today.stepsTaken).toBe(3);
    expect(today.heldSent).toBe(1);
    expect(today.heldStopped).toBe(1);
    // Thread 2 ended on a system note, not an answer
    expect(today.finishedTasks).toBe(1);
    expect(today.sites).toEqual([
      { host: 'slack.com', share: 2 / 3 },
      { host: 'mail.google.com', share: 1 / 3 },
    ]);
  });

  it('marks call hours, and counts their minutes and words', () => {
    const today = summarizeToday({
      ...base,
      meetings: [
        { id: 'm1', startedAt: at(11, 30), endedAt: at(12, 10) },
        { id: 'old', startedAt: DAY - 7_200_000, endedAt: DAY - 3_600_000 },
      ],
      segments: [
        { meetingId: 'm1', text: 'Stage two closes Friday' },
        { meetingId: 'old', text: 'not today' },
      ],
    });
    expect(today.calls).toBe(1);
    expect(today.callMinutes).toBe(40);
    expect(today.wordsCaught).toBe(4);
    expect(today.hours[11].call).toBe(true);
    expect(today.hours[12].call).toBe(true);
    expect(today.hours[13].call).toBe(false);
  });
});

describe('topSites', () => {
  it('folds the long tail into other', () => {
    const sites = ['a', 'b', 'c', 'd', 'e'].map(host => ({ host, share: 0.2 }));
    expect(topSites(sites).map(site => site.host)).toEqual(['a', 'b', 'c', 'other']);
    expect(topSites(sites)[3].share).toBeCloseTo(0.4);
    expect(topSites(sites.slice(0, 4))).toHaveLength(4);
  });
});
