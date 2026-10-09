import { describe, expect, it } from 'vitest';
import { eventsBetween, parseTime } from '../ics';

const feed = (...events: string[]) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    ...events.flatMap(event => ['BEGIN:VEVENT', event, 'END:VEVENT']),
    'END:VCALENDAR',
  ].join('\r\n');

const utc = (iso: string) => new Date(iso).getTime();

describe('parseTime', () => {
  it('reads UTC, zoned and all-day values', () => {
    expect(parseTime('20261009T090000Z').time).toBe(utc('2026-10-09T09:00:00Z'));
    // Lagos is UTC+1 all year
    expect(parseTime('20261009T100000', 'Africa/Lagos').time).toBe(utc('2026-10-09T09:00:00Z'));
    // New York is UTC-4 in October
    expect(parseTime('20261009T050000', 'America/New_York').time).toBe(utc('2026-10-09T09:00:00Z'));
    expect(parseTime('20261009')).toMatchObject({ allDay: true });
  });
});

describe('eventsBetween', () => {
  it('lists single events in the window with their meeting link', () => {
    const ics = feed(
      'UID:a\r\nSUMMARY:Stage 2 sync\r\nDTSTART:20261009T090000Z\r\nDTEND:20261009T093000Z\r\nDESCRIPTION:Join: https://meet.google.com/abc-defg-hij\\nAgenda',
      'UID:b\r\nSUMMARY:Next week\r\nDTSTART:20261016T090000Z\r\nDTEND:20261016T100000Z',
      'UID:c\r\nSUMMARY:Cancelled\r\nSTATUS:CANCELLED\r\nDTSTART:20261009T110000Z',
    );
    const events = eventsBetween(ics, utc('2026-10-09T00:00:00Z'), utc('2026-10-10T00:00:00Z'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: 'Stage 2 sync',
      start: utc('2026-10-09T09:00:00Z'),
      end: utc('2026-10-09T09:30:00Z'),
      joinUrl: 'https://meet.google.com/abc-defg-hij',
    });
  });

  it('expands a weekly repeat, skipping cancelled and moved dates', () => {
    const ics = feed(
      'UID:standup\r\nSUMMARY:Standup\r\nDTSTART:20261005T090000Z\r\nDTEND:20261005T091500Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\r\nEXDATE:20261007T090000Z',
      'UID:standup\r\nSUMMARY:Standup (moved)\r\nRECURRENCE-ID:20261009T090000Z\r\nDTSTART:20261009T130000Z\r\nDTEND:20261009T131500Z',
    );
    const events = eventsBetween(ics, utc('2026-10-05T00:00:00Z'), utc('2026-10-13T00:00:00Z'));
    expect(events.map(event => [event.title, new Date(event.start).toISOString()])).toEqual([
      ['Standup', '2026-10-05T09:00:00.000Z'],
      ['Standup (moved)', '2026-10-09T13:00:00.000Z'],
      ['Standup', '2026-10-12T09:00:00.000Z'],
    ]);
  });

  it('stops a repeat at COUNT and UNTIL', () => {
    const daily = (rule: string) =>
      feed(`UID:d\r\nSUMMARY:Daily\r\nDTSTART:20261001T080000Z\r\nDTEND:20261001T081000Z\r\nRRULE:${rule}`);
    const window = [utc('2026-10-01T00:00:00Z'), utc('2026-10-31T00:00:00Z')] as const;
    expect(eventsBetween(daily('FREQ=DAILY;COUNT=3'), ...window)).toHaveLength(3);
    expect(eventsBetween(daily('FREQ=DAILY;UNTIL=20261004T235959Z'), ...window)).toHaveLength(4);
    expect(
      eventsBetween(daily('FREQ=DAILY;INTERVAL=2;COUNT=3'), ...window).map(e => new Date(e.start).getUTCDate()),
    ).toEqual([1, 3, 5]);
  });

  it('keeps an event that is already under way', () => {
    const ics = feed('UID:e\r\nSUMMARY:Long call\r\nDTSTART:20261009T080000Z\r\nDTEND:20261009T100000Z');
    expect(eventsBetween(ics, utc('2026-10-09T09:00:00Z'), utc('2026-10-09T12:00:00Z'))).toHaveLength(1);
  });
});
