import { describe, expect, it } from 'vitest';
import { SECRET_ICS, calendarOf } from '../connect';

describe('SECRET_ICS', () => {
  it('accepts only a Google Calendar secret address', () => {
    expect(
      SECRET_ICS.test(
        'https://calendar.google.com/calendar/ical/avi%40example.com/private-0123456789abcdef0123456789abcdef/basic.ics',
      ),
    ).toBe(true);
    expect(SECRET_ICS.test('https://calendar.google.com/calendar/ical/avi%40example.com/public/basic.ics')).toBe(false);
    expect(
      SECRET_ICS.test('https://calendar.google.com.evil.example/calendar/ical/a/private-0123456789abcdef/basic.ics'),
    ).toBe(false);
  });
});

describe('calendarOf', () => {
  it('names the calendar of a secret address', () => {
    expect(
      calendarOf('https://calendar.google.com/calendar/ical/avi%40example.com/private-0123456789abcdef/basic.ics'),
    ).toBe('avi@example.com');
  });
});
