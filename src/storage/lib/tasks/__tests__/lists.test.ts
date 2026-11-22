import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { AviCopilotDb } from '../../threads/db';
import { createTaskListStore } from '../lists';

const DAY = 24 * 60 * 60 * 1000;

describe('the task lists Ava sent on WhatsApp', () => {
  it('keeps ids only, finds a list by its message, and the latest numbered one before a moment', async () => {
    let now = 1_000_000;
    const lists = createTaskListStore(new AviCopilotDb(`lists-${crypto.randomUUID()}`), { now: () => now });
    await lists.save({ messageId: 'wa-1', taskIds: ['tsk_aaaaaaaaaa', 'tsk_bbbbbbbbbb'], numbered: true });
    now += 1000;
    await lists.save({ messageId: 'wa-2', taskIds: ['tsk_cccccccccc'], numbered: false });
    now += 1000;
    await lists.save({ messageId: 'wa-3', taskIds: ['tsk_dddddddddd'], numbered: true });
    expect(await lists.get('wa-1')).toEqual({
      messageId: 'wa-1',
      taskIds: ['tsk_aaaaaaaaaa', 'tsk_bbbbbbbbbb'],
      sentAt: 1_000_000,
      numbered: true,
    });
    expect((await lists.latestNumbered())?.messageId).toBe('wa-3');
    // A message that came before wa-3 went out means wa-1; a confirmation is never a numbered list
    expect((await lists.latestNumbered(1_001_500))?.messageId).toBe('wa-1');
    expect(await lists.latestNumbered(999_999)).toBeUndefined();
    await lists.setClosedByReaction('wa-2', true);
    expect((await lists.get('wa-2'))?.closedByReaction).toBe(true);
    now += 91 * DAY;
    expect(await lists.prune()).toBe(3);
  });
});
