import { describe, expect, it } from 'vitest';
import type { ThreadRecord } from '@extension/storage';
import { groupByDate } from '../history';

const NOW = new Date(2026, 9, 11, 15, 0).getTime();
const DAY = 86_400_000;
const thread = (id: string, updatedAt: number, pinned = false) => ({ id, updatedAt, pinned }) as ThreadRecord;

describe('groupByDate', () => {
  it('groups chats like chat apps do, pinned first and newest first', () => {
    const groups = groupByDate(
      [
        thread('old', new Date(2026, 6, 3).getTime()),
        thread('today-early', new Date(2026, 9, 11, 9).getTime()),
        thread('today-late', new Date(2026, 9, 11, 14).getTime()),
        thread('yesterday', NOW - DAY),
        thread('week', NOW - 4 * DAY),
        thread('month', NOW - 20 * DAY),
        thread('august', new Date(2026, 7, 20).getTime()),
        thread('pinned-old', new Date(2025, 0, 1).getTime(), true),
      ],
      NOW,
    );
    expect(groups.map(group => group.key)).toEqual([
      'pinned',
      'today',
      'yesterday',
      'week',
      'month',
      'month:2026-08',
      'month:2026-07',
    ]);
    expect(groups[1].threads.map(item => item.id)).toEqual(['today-late', 'today-early']);
    expect(groups[5].label).toMatch(/2026/);
  });

  it('has no empty groups', () => {
    expect(groupByDate([], NOW)).toEqual([]);
  });
});
