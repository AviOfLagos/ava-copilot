import { describe, expect, it } from 'vitest';
import type { GraphNode, ThreadRecord } from '@extension/storage';
import { briefDue, briefMarkdown, priorityLines, todaysEvents } from '../brief';

const NOW = new Date(2026, 9, 12, 8, 30).getTime();
const HOUR = 3_600_000;
const node = (type: GraphNode['type'], label: string, workspaceId: string | null, ago = HOUR): GraphNode => ({
  id: label,
  type,
  label,
  workspaceId,
  sourceItemIds: [],
  date: NOW - ago,
  updatedAt: 0,
});

describe('briefDue', () => {
  it('comes once a day, after its time', () => {
    const settings = { enabled: true, hour: 8, minute: 0, lastDay: '' };
    expect(briefDue(settings, NOW)).toBe(true);
    expect(briefDue({ ...settings, lastDay: '2026-10-12' }, NOW)).toBe(false);
    expect(briefDue({ ...settings, hour: 9 }, NOW)).toBe(false);
    expect(briefDue({ ...settings, enabled: false }, NOW)).toBe(false);
  });
});

describe('briefMarkdown', () => {
  it('puts the priorities first, then today, what waits, and each workspace', () => {
    const text = briefMarkdown(
      {
        now: NOW,
        events: [
          {
            id: 'b',
            title: 'Sponsor sync ![x](https://evil.test)',
            start: NOW + 2 * HOUR,
            end: NOW + 3 * HOUR,
            joinUrl: 'https://meet.google.com/abc-defg-hij',
          },
          { id: 'a', title: 'Standup', start: NOW + HOUR, end: NOW + 1.5 * HOUR, joinUrl: null },
          { id: 'c', title: 'Tomorrow', start: NOW + 30 * HOUR, end: NOW + 31 * HOUR, joinUrl: null },
        ],
        actions: [node('action', 'Finish the sponsor deck', 'tef'), node('action', 'Old task', 'tef', 30 * 24 * HOUR)],
        decisions: [node('decision', 'Ticketing moves to Paystack', 'tef')],
        waiting: [{ title: 'Post the launch', status: 'waiting_confirm' } as ThreadRecord],
        stopped: [],
        workspaces: [{ id: 'tef', name: 'Tech Ember Fest', about: '', keywords: [], accounts: {}, createdAt: 0 }],
      },
      ['Prepare for the sponsor sync at 10:30'],
    );
    expect(text.indexOf('First, today')).toBeLessThan(text.indexOf("Today's calendar"));
    expect(text.indexOf('Standup')).toBeLessThan(text.indexOf('Sponsor sync'));
    expect(text).not.toContain('Tomorrow');
    expect(text).not.toMatch(/!\[|\]\(/);
    expect(text).toContain('waits for your click');
    expect(text).toContain('**Tech Ember Fest**');
    expect(text).toContain('- [ ] Finish the sponsor deck');
    expect(text).not.toContain('Old task');
    expect(text).toContain('Ticketing moves to Paystack');
  });
});

describe('todaysEvents and priorityLines', () => {
  it('keep today only, and three plain lines', () => {
    expect(
      todaysEvents([{ id: 'x', title: 'Done', start: NOW - 2 * HOUR, end: NOW - HOUR, joinUrl: null }], NOW),
    ).toEqual([]);
    expect(priorityLines('Sure!\n- One\n* Two\n- Three\n- Four')).toEqual(['One', 'Two', 'Three']);
  });
});
