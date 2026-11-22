import { describe, expect, it } from 'vitest';
import { dueFromText, isoDay } from '../due';

// Wednesday 18 November 2026, 10:00 local
const WED = new Date(2026, 10, 18, 10).getTime();
// Friday 20 November 2026, 16:00 local
const FRI = new Date(2026, 10, 20, 16).getTime();

describe('a due date from the words used', () => {
  it.each([
    ['by Friday', WED, '2026-11-20'],
    ['Friday', WED, '2026-11-20'],
    ['by Fri', WED, '2026-11-20'],
    ['by Friday', FRI, '2026-11-20'],
    ['next Friday', FRI, '2026-11-27'],
    ['Monday', WED, '2026-11-23'],
    ['today', WED, '2026-11-18'],
    ['end of day', WED, '2026-11-18'],
    ['tomorrow', WED, '2026-11-19'],
    ['in 3 days', WED, '2026-11-21'],
    ['in two weeks', WED, '2026-12-02'],
    ['end of the week', WED, '2026-11-20'],
    ['end of the month', WED, '2026-11-30'],
    ['2026-12-01', WED, '2026-12-01'],
    ['by Nov 28', WED, '2026-11-28'],
    ['28th of November', WED, '2026-11-28'],
    ['December 3rd', WED, '2026-12-03'],
    ['Jan 5', WED, '2027-01-05'],
    ['Nov 2', WED, '2027-11-02'],
  ])('"%s" said on %s is %s', (words, said, expected) => {
    expect(dueFromText(words, said)).toBe(expected);
  });

  it.each([['soon'], ['ASAP'], [''], ['Feb 30'], ['when Bo is back'], ['Janet 5'], ['3 decks'], ['by 4 marchers']])(
    '"%s" gives no date',
    words => {
      expect(dueFromText(words, WED)).toBeUndefined();
    },
  );

  it('writes local days', () => {
    expect(isoDay(new Date(2026, 0, 5, 23, 30).getTime())).toBe('2026-01-05');
  });
});
