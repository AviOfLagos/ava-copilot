import type { ObserveInput } from '@extension/storage';
import type { CalendarEvent, CalendarPerson } from '../calendar/ics';
import { ownerEmails } from './owner';
import { people } from './people';
import type { People } from './people';

/**
 * Calendar invites (docs/pm-desk.md 5.2, 5.3): every invitee and organizer with an address is observed. The
 * address is what counts: a Gmail sender or a call's attendee with the same address is the same person. An
 * invite's names are written by whoever sent it, so a name alone never gives anyone an address (see the store).
 */

/** The invite's own id, the same for every repeat of a recurring event: one event is one sighting. */
export const inviteRef = (eventId: string) => `cal:${eventId.replace(/@\d+$/, '')}`;

/** The people on an invite who are not the owner: attendees and the organizer, one per address. */
export function inviteesOf(event: Pick<CalendarEvent, 'attendees' | 'organizer'>, own: Set<string>): CalendarPerson[] {
  const out: CalendarPerson[] = [];
  for (const person of [...(event.attendees ?? []), ...(event.organizer ? [event.organizer] : [])]) {
    if (!person.email || own.has(person.email)) continue;
    if (out.some(other => other.email === person.email)) continue;
    out.push(person);
  }
  return out;
}

/** What the store is told for one invitee. */
export function inviteeInput(person: CalendarPerson, eventId: string): ObserveInput {
  return {
    text: person.name || (person.email ?? '').split('@')[0],
    source: 'calendar',
    // An invite belongs to no workspace; the address is the same person everywhere
    workspaceId: null,
    email: person.email,
    ref: inviteRef(eventId),
    context: 'was on a calendar invite',
  };
}

// Invitees already told to the store since the background started: a calendar read every few minutes
const learned = new Set<string>();

export async function learnFromCalendar(
  events: Pick<CalendarEvent, 'id' | 'attendees' | 'organizer'>[],
  deps: { people: Pick<People, 'observeAll'>; own: () => Promise<Set<string>> } = { people, own: ownerEmails },
): Promise<number> {
  const own = await deps.own();
  const inputs: ObserveInput[] = [];
  for (const event of events) {
    for (const person of inviteesOf(event, own)) {
      const key = `${inviteRef(event.id)}|${person.email}`;
      if (learned.has(key)) continue;
      if (learned.size > 5000) learned.clear();
      learned.add(key);
      inputs.push(inviteeInput(person, event.id));
    }
  }
  if (inputs.length) await deps.people.observeAll(inputs);
  return inputs.length;
}
