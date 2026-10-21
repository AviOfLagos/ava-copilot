import { describe, expect, it } from 'vitest';
import { byAccount, macCardState, toggleCalendar } from '../macCalendar';

describe('macCardState', () => {
  it('follows Nex Brain’s answer', () => {
    expect(macCardState({ reply: null, error: null })).toBe('loading');
    expect(macCardState({ reply: null, error: 'Nex Brain is not running on your Mac.' })).toBe('offline');
    expect(macCardState({ reply: { paired: false }, error: null })).toBe('unpaired');
    expect(macCardState({ reply: { paired: true, access: 'granted' }, error: null })).toBe('ready');
    expect(macCardState({ reply: { paired: true, access: 'not_determined' }, error: null })).toBe('needs_permission');
    expect(macCardState({ reply: { paired: true, access: 'denied' }, error: null })).toBe('denied');
    expect(macCardState({ reply: { paired: true, access: 'write_only' }, error: null })).toBe('denied');
    expect(macCardState({ reply: { paired: true, access: 'restricted' }, error: null })).toBe('denied');
    expect(macCardState({ reply: { paired: true, access: 'unavailable' }, error: null })).toBe('unavailable');
  });
});

describe('toggleCalendar', () => {
  const all = ['work', 'home', 'birthdays'];
  it('turns "all" into a list when one is unticked, and back to all when it is ticked again', () => {
    const some = toggleCalendar(null, all, 'birthdays', false);
    expect(some).toEqual(['work', 'home']);
    expect(toggleCalendar(some, all, 'birthdays', true)).toBeNull();
    expect(toggleCalendar(['work'], all, 'work', false)).toEqual([]);
  });
});

describe('byAccount', () => {
  it('groups calendars by their account', () => {
    const groups = byAccount([
      { id: 'a', title: 'Work', account: 'avi@nexprove.com', color: null },
      { id: 'b', title: 'Home', account: 'iCloud', color: null },
      { id: 'c', title: 'Team', account: 'avi@nexprove.com', color: null },
      { id: 'd', title: 'Holidays', account: '', color: null },
    ]);
    expect(groups.map(group => [group.account, group.calendars.map(item => item.id)])).toEqual([
      ['avi@nexprove.com', ['a', 'c']],
      ['iCloud', ['b']],
      ['Other', ['d']],
    ]);
  });
});
