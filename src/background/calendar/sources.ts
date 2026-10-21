import { toAppError } from '@extension/shared';
import type { CalendarSettingsConfig, CalendarSourceName } from '@extension/storage';
import type { MacEvent } from '@src/shared/lib/protocol/companion';
import type { CompanionClient } from '../companion/client';
import { eventsBetween, joinLinkIn } from './ics';
import type { CalendarEvent } from './ics';

/**
 * Where the calendar's events come from. The Mac's Calendar through Nex Brain comes first when it is paired and
 * the user has not turned it off: it reads every account macOS syncs (Google Workspace too, where the secret iCal
 * address is often disabled) and needs nothing scraped from a page. The iCal address is the fallback. Either way
 * the events are the same shape, and their text is data written by whoever sent the invite.
 */

export interface CalendarSource {
  name: CalendarSourceName;
  read(from: number, to: number): Promise<CalendarEvent[]>;
}

/** Which sources to try, in order. */
export function planSources(input: {
  paired: boolean;
  settings: Pick<CalendarSettingsConfig, 'icsUrl' | 'macEnabled'>;
}): CalendarSourceName[] {
  const plan: CalendarSourceName[] = [];
  if (input.paired && input.settings.macEnabled) plan.push('mac');
  if (input.settings.icsUrl.trim()) plan.push('ics');
  return plan;
}

/** A Mac event as the copilot keeps events; the join link is found again here, never taken on trust. */
export function fromMacEvent(event: MacEvent): CalendarEvent {
  return {
    id: event.id,
    title: event.title || 'Untitled event',
    start: event.start,
    end: event.end > event.start ? event.end : event.start + 30 * 60_000,
    allDay: event.allDay,
    location: event.location,
    joinUrl: joinLinkIn(`${event.location} ${event.url ?? ''} ${event.notes}`),
  };
}

export function macSource(
  client: Pick<CompanionClient, 'calendarEvents'>,
  calendarIds: string[] | null,
): CalendarSource {
  return {
    name: 'mac',
    async read(from, to) {
      // No calendar ticked: nothing counts
      if (calendarIds && calendarIds.length === 0) return [];
      const { events } = await client.calendarEvents(from, to, calendarIds);
      return events.map(fromMacEvent).sort((a, b) => a.start - b.start);
    },
  };
}

/** What a failed iCal fetch means, in words the user can act on. */
export function icsProblem(status: number, url: string): string {
  const google = /^https:\/\/calendar\.google\.com\//i.test(url);
  if (status === 404 || status === 410) {
    return google
      ? 'Google no longer accepts this calendar address (it may have been reset). Copy the secret address again.'
      : 'The calendar address was not found. Check it and paste it again.';
  }
  if (status === 401 || status === 403) {
    return google
      ? 'Google refused this calendar address. Your Google Workspace admin may have turned secret addresses off.'
      : 'The calendar refused this address. Check that it is the private (secret) one.';
  }
  return `The calendar answered ${status}. Try again later.`;
}

export function icsSource(
  icsUrl: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): CalendarSource {
  return {
    name: 'ics',
    async read(from, to) {
      const url = icsUrl.trim().replace(/^webcal:/i, 'https:');
      // Plain http only for a calendar on this machine
      if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url)) {
        throw new Error('The calendar address must start with https:// or webcal://');
      }
      const response = await fetchImpl(url, { credentials: 'omit', cache: 'no-store' });
      if (!response.ok) throw new Error(icsProblem(response.status, url));
      const text = await response.text();
      // A sign-in page or another page instead of a feed
      if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 2000))) {
        throw new Error('That address is not an iCal feed. Paste the “Secret address in iCal format”, ending in .ics.');
      }
      return eventsBetween(text, from, to);
    },
  };
}

/**
 * Reads from the first source that answers. When every source fails, the first one's problem is the one said
 * (the Mac's, when it is tried first: it names the step on the Mac to take).
 */
export async function readFromSources(
  sources: CalendarSource[],
  from: number,
  to: number,
): Promise<{ events: CalendarEvent[]; source: CalendarSourceName | null; error: string | null }> {
  let firstError: string | null = null;
  for (const source of sources) {
    try {
      return { events: await source.read(from, to), source: source.name, error: null };
    } catch (error) {
      firstError ??= toAppError(error).message;
    }
  }
  return { events: [], source: null, error: firstError };
}
