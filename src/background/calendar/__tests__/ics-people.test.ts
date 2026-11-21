import { describe, expect, it } from 'vitest';
import { eventsBetween } from '../ics';

// A saved invite with made-up people, the way Google Calendar exports one
const INVITE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:weekly-sync-1@example.test',
  'DTSTART:20261123T090000Z',
  'DTEND:20261123T093000Z',
  'SUMMARY:Weekly sync',
  'LOCATION:https://meet.google.com/abc-defg-hij',
  'ORGANIZER;CN=Tolu Bello:mailto:tolu@example.test',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN="Okafor, Adaeze: PM";X-NUM-GUESTS=0:mailto:Ada@Example.test',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=kunle@example.test;X-NUM-GUESTS=0:mailto:kunle@example.test',
  'ATTENDEE;CUTYPE=ROOM;ROLE=REQ-PARTICIPANT;CN=Room 4:mailto:room4@resource.example.test',
  'ATTENDEE;ROLE=NON-PARTICIPANT;CN=Note taker:mailto:notes@example.test',
  'ATTENDEE;CN=Tolu',
  '  Bello:mailto:tolu@example.test',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('invite people', () => {
  const [event] = eventsBetween(INVITE, Date.UTC(2026, 10, 23), Date.UTC(2026, 10, 24));

  it('reads ATTENDEE and ORGANIZER names and addresses', () => {
    expect(event.organizer).toEqual({ name: 'Tolu Bello', email: 'tolu@example.test' });
    expect(event.attendees).toEqual([
      // A quoted name keeps its colon and comma
      { name: 'Okafor, Adaeze: PM', email: 'ada@example.test' },
      // A name that is only the address says nothing more
      { name: '', email: 'kunle@example.test' },
      // A folded line is read whole
      { name: 'Tolu Bello', email: 'tolu@example.test' },
    ]);
  });

  it('leaves out rooms and people not taking part', () => {
    expect(event.attendees?.some(person => /room|notes/.test(person.email ?? ''))).toBe(false);
  });

  it('still reads the rest of the event', () => {
    expect(event.title).toBe('Weekly sync');
    expect(event.joinUrl).toBe('https://meet.google.com/abc-defg-hij');
  });
});
