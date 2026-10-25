import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@extension/shared';
import type { MacEvent } from '@src/shared/lib/protocol/companion';
import { fromMacEvent, icsProblem, icsSource, macSource, planSources, readFromSources } from '../sources';
import type { CalendarSource } from '../sources';

const HOUR = 3_600_000;
const settings = (icsUrl = '', macEnabled = true) => ({ icsUrl, macEnabled });

const macEvent = (overrides: Partial<MacEvent> = {}): MacEvent => ({
  id: 'E1@1',
  calendarId: 'work',
  calendar: 'Work',
  title: 'Standup',
  start: 2 * HOUR,
  end: 3 * HOUR,
  allDay: false,
  location: '',
  notes: '',
  url: null,
  joinUrl: null,
  ...overrides,
});

const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:one',
  'DTSTART:19700101T020000Z',
  'DTEND:19700101T030000Z',
  'SUMMARY:From the feed',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('planSources', () => {
  it('puts the Mac first when Ava Brain is paired, the iCal address after', () => {
    expect(planSources({ paired: true, settings: settings('https://x/basic.ics') })).toEqual(['mac', 'ics']);
    expect(planSources({ paired: true, settings: settings('') })).toEqual(['mac']);
    expect(planSources({ paired: false, settings: settings('https://x/basic.ics') })).toEqual(['ics']);
    expect(planSources({ paired: true, settings: settings('https://x/basic.ics', false) })).toEqual(['ics']);
    expect(planSources({ paired: false, settings: settings('  ') })).toEqual([]);
  });
});

describe('readFromSources', () => {
  const ok = (name: 'mac' | 'ics', title: string): CalendarSource => ({
    name,
    read: async () => [fromMacEvent(macEvent({ title }))],
  });
  const failing = (name: 'mac' | 'ics', message: string): CalendarSource => ({
    name,
    read: async () => {
      throw new AppError('forbidden', message);
    },
  });

  it('takes the first source that answers', async () => {
    const read = await readFromSources([ok('mac', 'Mac'), ok('ics', 'Feed')], 0, HOUR);
    expect(read.source).toBe('mac');
    expect(read.events[0].title).toBe('Mac');
  });

  it('falls back to the iCal address when the Mac cannot be read', async () => {
    const read = await readFromSources([failing('mac', 'Allow Calendars'), ok('ics', 'Feed')], 0, HOUR);
    expect(read).toMatchObject({ source: 'ics', error: null });
  });

  it('says the first problem when nothing answers', async () => {
    const read = await readFromSources([failing('mac', 'Allow Calendars'), failing('ics', 'Feed gone')], 0, HOUR);
    expect(read).toEqual({ events: [], source: null, error: 'Allow Calendars' });
  });
});

describe('macSource', () => {
  it('asks Ava Brain for the window and the calendars that count, and finds join links itself', async () => {
    const calendarEvents = vi.fn(async () => ({
      ok: true as const,
      truncated: false,
      events: [
        macEvent({ id: 'late', start: 5 * HOUR, end: 6 * HOUR }),
        // A join link Ava Brain sent is not taken on trust: it is found again from the text
        macEvent({ id: 'early', joinUrl: 'https://evil.example/j/1', notes: 'https://meet.google.com/abc-defg-hij' }),
      ],
    }));
    const events = await macSource({ calendarEvents }, ['work']).read(0, 24 * HOUR);
    expect(calendarEvents).toHaveBeenCalledWith(0, 24 * HOUR, ['work']);
    expect(events.map(event => [event.id, event.joinUrl])).toEqual([
      ['early', 'https://meet.google.com/abc-defg-hij'],
      ['late', null],
    ]);
  });

  it('reads nothing when no calendar is ticked', async () => {
    const calendarEvents = vi.fn();
    expect(await macSource({ calendarEvents }, []).read(0, HOUR)).toEqual([]);
    expect(calendarEvents).not.toHaveBeenCalled();
  });
});

describe('icsSource', () => {
  const respond = (body: string, status = 200) =>
    vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

  it('reads a feed, webcal included', async () => {
    const fetchImpl = respond(ICS);
    const events = await icsSource('webcal://calendar.example/basic.ics', fetchImpl).read(0, 24 * HOUR);
    expect(events.map(event => event.title)).toEqual(['From the feed']);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      'https://calendar.example/basic.ics',
    );
  });

  it('says plainly what a failed or wrong address means', async () => {
    const google = 'https://calendar.google.com/calendar/ical/a/private-0123456789abcdef/basic.ics';
    await expect(icsSource(google, respond('', 404)).read(0, HOUR)).rejects.toThrow(/no longer accepts/);
    await expect(icsSource(google, respond('', 403)).read(0, HOUR)).rejects.toThrow(/Workspace admin/);
    await expect(icsSource(google, respond('<html>Sign in</html>')).read(0, HOUR)).rejects.toThrow(/not an iCal feed/);
    await expect(icsSource('http://example.com/a.ics', respond(ICS)).read(0, HOUR)).rejects.toThrow(/https/);
    expect(icsProblem(500, 'https://x')).toMatch(/answered 500/);
  });
});
