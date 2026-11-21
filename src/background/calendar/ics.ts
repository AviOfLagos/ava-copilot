/*
 * Reads an iCalendar (.ics) feed, such as Google Calendar's "secret address in iCal format", into the
 * events of a time window. Handles what calendars export day to day: time zones, all-day events,
 * daily and weekly repeats with INTERVAL, BYDAY, COUNT and UNTIL, cancelled dates (EXDATE) and moved
 * occurrences (RECURRENCE-ID). Monthly and yearly repeats show only their first date.
 */

import { meetingLinkIn } from '@src/shared/lib/protocol/companion';

export interface CalendarEvent {
  // Unique per occurrence: the event's UID plus its start
  id: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location: string;
  // A meeting link found in the location or description (Meet, Zoom, Teams)
  joinUrl: string | null;
  // Who was invited, and who sent it (docs/pm-desk.md 5.3): names and addresses as the invite gives them, which
  // anyone can write. The Mac's Calendar does not give them yet (issue #32)
  attendees?: CalendarPerson[];
  organizer?: CalendarPerson | null;
}

export interface CalendarPerson {
  name: string;
  email: string | null;
}

// The most invitees kept per event
const MAX_ATTENDEES = 50;

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface RawEvent {
  uid: string;
  props: Prop[];
}

const DAY = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
// The meeting link of an event: shared with Ava Brain, which reads the Mac's Calendar
export const joinLinkIn = meetingLinkIn;

/** Lines of the feed with folded continuation lines joined back. */
function unfold(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
}

/** Splits at `separator` outside double quotes: a quoted name may hold a colon or a semicolon. */
function splitOutsideQuotes(text: string, separator: string, limit = Infinity): string[] {
  const parts: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length && parts.length < limit - 1; i++) {
    if (text[i] === '"') quoted = !quoted;
    else if (text[i] === separator && !quoted) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function parseLine(line: string): Prop | null {
  const [head, value] = splitOutsideQuotes(line, ':', 2);
  if (value === undefined) return null;
  const [name, ...rest] = splitOutsideQuotes(head, ';');
  const params: Record<string, string> = {};
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq !== -1) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

/**
 * An ATTENDEE or ORGANIZER line as a person: the CN name and the mailto address. Rooms, resources and groups are
 * not people, and neither is someone marked as not taking part.
 */
export function calendarPerson(prop: Prop): CalendarPerson | null {
  const kind = (prop.params.CUTYPE ?? 'INDIVIDUAL').toUpperCase();
  if (kind !== 'INDIVIDUAL' && kind !== 'UNKNOWN') return null;
  if ((prop.params.ROLE ?? '').toUpperCase() === 'NON-PARTICIPANT') return null;
  const address = /^mailto:(.+)$/i.exec(prop.value.trim())?.[1]?.trim().toLowerCase() ?? null;
  const email = address && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : null;
  const name = unescape(prop.params.CN ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (!name && !email) return null;
  // A CN that is only the address says nothing more
  return { name: name && name.toLowerCase() !== email ? name : '', email };
}

function peopleOf(event: RawEvent): { attendees: CalendarPerson[]; organizer: CalendarPerson | null } {
  const organizerProp = event.props.find(prop => prop.name === 'ORGANIZER');
  const organizer = organizerProp ? calendarPerson(organizerProp) : null;
  const attendees: CalendarPerson[] = [];
  for (const prop of event.props) {
    if (prop.name !== 'ATTENDEE' || attendees.length >= MAX_ATTENDEES) continue;
    const person = calendarPerson(prop);
    if (person && !attendees.some(other => person.email && other.email === person.email)) attendees.push(person);
  }
  return { attendees, organizer };
}

function unescape(value: string): string {
  return value.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

/** Milliseconds a time zone is ahead of UTC at a moment. */
function zoneOffset(utc: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(utc));
    const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utc;
  } catch {
    return 0;
  }
}

/** A DATE or DATE-TIME value as a moment; floating times are read in the local zone. */
export function parseTime(value: string, timeZone?: string): { time: number; allDay: boolean } {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!match) return { time: NaN, allDay: false };
  const [, y, mo, d, h, mi, s, z] = match;
  if (h === undefined) {
    return { time: new Date(Number(y), Number(mo) - 1, Number(d)).getTime(), allDay: true };
  }
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (z) return { time: wall, allDay: false };
  if (timeZone) {
    // The wall time in that zone: subtract its offset, then correct once around a clock change
    let utc = wall - zoneOffset(wall, timeZone);
    utc = wall - zoneOffset(utc, timeZone);
    return { time: utc, allDay: false };
  }
  return {
    time: new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime(),
    allDay: false,
  };
}

function rawEvents(text: string): RawEvent[] {
  const events: RawEvent[] = [];
  let current: Prop[] | null = null;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') current = [];
    else if (line === 'END:VEVENT' && current) {
      events.push({ uid: current.find(prop => prop.name === 'UID')?.value ?? String(events.length), props: current });
      current = null;
    } else if (current) {
      const prop = parseLine(line);
      if (prop) current.push(prop);
    }
  }
  return events;
}

function timeOf(event: RawEvent, name: string) {
  const prop = event.props.find(item => item.name === name);
  return prop ? parseTime(prop.value, prop.params.TZID) : null;
}

/** The start times of a repeating event inside a window. */
export function occurrences(start: number, rule: string, from: number, to: number, exclude: Set<number>): number[] {
  const parts = Object.fromEntries(rule.split(';').map(part => part.split('=') as [string, string]));
  const freq = parts.FREQ;
  const interval = Math.max(1, Number(parts.INTERVAL ?? 1));
  const count = parts.COUNT ? Number(parts.COUNT) : Infinity;
  const until = parts.UNTIL ? parseTime(parts.UNTIL).time : Infinity;
  if (freq !== 'DAILY' && freq !== 'WEEKLY') return start >= from && start < to ? [start] : [];

  const days = parts.BYDAY ? parts.BYDAY.split(',').map(day => WEEKDAYS.indexOf(day.slice(-2))) : null;
  const first = new Date(start);
  const out: number[] = [];
  let seen = 0;
  // Walk day by day from the first occurrence; the window is short, so this stays cheap
  for (let day = 0; day < 3700; day++) {
    const candidate = new Date(first);
    candidate.setDate(first.getDate() + day);
    const time = candidate.getTime();
    if (time > until || seen >= count || time >= to) break;
    let matches: boolean;
    if (freq === 'DAILY') {
      matches = day % interval === 0;
    } else {
      const week = Math.floor((day + first.getDay()) / 7);
      const weekday = candidate.getDay();
      matches = week % interval === 0 && (days ? days.includes(weekday) : weekday === first.getDay());
    }
    if (!matches) continue;
    seen += 1;
    if (time >= from && !exclude.has(time)) out.push(time);
  }
  return out;
}

/**
 * The events of a feed that overlap a window, soonest first.
 */
export function eventsBetween(ics: string, from: number, to: number): CalendarEvent[] {
  const raw = rawEvents(ics);
  // Occurrences moved to another time replace the ones the rule would have made
  const moved = new Map<string, Set<number>>();
  for (const event of raw) {
    const recurrenceId = timeOf(event, 'RECURRENCE-ID');
    if (recurrenceId) moved.set(event.uid, (moved.get(event.uid) ?? new Set()).add(recurrenceId.time));
  }

  const out: CalendarEvent[] = [];
  for (const event of raw) {
    const status = event.props.find(prop => prop.name === 'STATUS')?.value;
    if (status === 'CANCELLED') continue;
    const start = timeOf(event, 'DTSTART');
    if (!start || Number.isNaN(start.time)) continue;
    const endTime = timeOf(event, 'DTEND')?.time;
    const length = endTime && endTime > start.time ? endTime - start.time : start.allDay ? DAY : 30 * 60 * 1000;
    const text = (name: string) => unescape(event.props.find(prop => prop.name === name)?.value ?? '');
    const location = text('LOCATION');
    const joinUrl = joinLinkIn(`${location} ${text('DESCRIPTION')} ${text('URL')}`);
    const { attendees, organizer } = peopleOf(event);

    const rule = event.props.find(prop => prop.name === 'RRULE')?.value;
    const isOverride = event.props.some(prop => prop.name === 'RECURRENCE-ID');
    const exclude = new Set<number>(moved.get(event.uid) ?? []);
    for (const prop of event.props.filter(item => item.name === 'EXDATE')) {
      for (const value of prop.value.split(',')) exclude.add(parseTime(value, prop.params.TZID).time);
    }
    const starts =
      rule && !isOverride
        ? occurrences(start.time, rule, from - length, to, exclude)
        : start.time + length > from && start.time < to
          ? [start.time]
          : [];
    for (const time of starts) {
      if (time + length <= from) continue;
      out.push({
        id: `${event.uid}@${time}`,
        title: text('SUMMARY') || 'Untitled event',
        start: time,
        end: time + length,
        allDay: start.allDay,
        location,
        joinUrl,
        attendees,
        organizer,
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
