import { meetingStore, nameKey, upcomingEventsStore } from '@extension/storage';
import type { MeetingRecord, ObserveInput, TranscriptSegment, UpcomingEvent } from '@extension/storage';
import { isGenericSpeaker } from '../meetings/speakers';
import { inviteeInput, inviteesOf, inviteRef } from './calendar';
import { isNobody, isSelfName, ownerEmails } from './owner';
import { people } from './people';
import type { People } from './people';

/**
 * What a finished call teaches about people (docs/pm-desk.md 5.2-5.4): who was on it (the roster), who spoke
 * (caption speakers), who was given tasks (the note's action items), and, when the call matches a calendar
 * invite, the invitees' addresses. All in the meeting's workspace, all plain code.
 */

/** A meeting link as compared: host and path, without the query or a trailing slash. */
export function callKey(url: string | null | undefined): string | null {
  try {
    const parsed = new URL(url ?? '');
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, '').toLowerCase()}`;
  } catch {
    return null;
  }
}

/** The invite a call belongs to: the one whose meeting link is the call's own. */
export function inviteFor(
  meeting: Pick<MeetingRecord, 'url'>,
  events: Pick<UpcomingEvent, 'id' | 'joinUrl'>[],
): (typeof events)[number] | null {
  const key = callKey(meeting.url);
  if (!key) return null;
  const matches = events.filter(event => callKey(event.joinUrl) === key);
  return matches.length ? matches[0] : null;
}

/** Everything a finished call says about people, as `observe` inputs, in the order they are told. */
export function meetingInputs(
  meeting: Pick<MeetingRecord, 'id' | 'workspaceId' | 'roster' | 'note'>,
  segments: Pick<TranscriptSegment, 'speaker'>[],
  invite: Pick<UpcomingEvent, 'id' | 'attendees' | 'organizer'> | null,
  own: Set<string>,
): ObserveInput[] {
  const workspaceId = meeting.workspaceId ?? null;
  const ref = `meet:${meeting.id}`;
  const base = { workspaceId, meetingId: meeting.id, ref };
  const inputs: ObserveInput[] = [];
  const roster = (meeting.roster ?? []).filter(name => !isSelfName(name));
  for (const text of roster) inputs.push({ ...base, text, source: 'meet', context: 'was on the call' });

  // An invitee whose name is a roster name gives that person their address: both say they were on this call
  const rosterKeys = new Map(roster.map(name => [nameKey(name), name]));
  for (const invitee of invite ? inviteesOf(invite, own) : []) {
    const onCall = rosterKeys.get(nameKey(invitee.name));
    inputs.push(
      onCall
        ? { ...base, text: onCall, source: 'calendar', email: invitee.email, trusted: true, context: 'was invited' }
        : { ...inviteeInput(invitee, invite!.id), ref: inviteRef(invite!.id) },
    );
  }

  const spoke = new Map<string, { text: string; lines: number }>();
  for (const segment of segments) {
    if (isGenericSpeaker(segment.speaker) || isSelfName(segment.speaker)) continue;
    const key = nameKey(segment.speaker);
    const entry = spoke.get(key) ?? { text: segment.speaker, lines: 0 };
    entry.lines += 1;
    spoke.set(key, entry);
  }
  for (const { text } of spoke.values()) inputs.push({ ...base, text, source: 'meet', context: 'spoke on the call' });

  const owners = new Map<string, { text: string; tasks: number }>();
  for (const item of meeting.note?.actionItems ?? []) {
    const owner = item.owner?.trim() ?? '';
    if (!owner || isSelfName(owner) || isNobody(owner)) continue;
    const entry = owners.get(nameKey(owner)) ?? { text: owner, tasks: 0 };
    entry.tasks += 1;
    owners.set(nameKey(owner), entry);
  }
  for (const { text, tasks } of owners.values()) {
    inputs.push({
      ...base,
      text,
      source: 'spoken',
      tasks,
      context: tasks === 1 ? 'was given a task on the call' : `was given ${tasks} tasks on the call`,
    });
  }
  return inputs;
}

export interface MeetDeps {
  meetings: {
    get: (id: string) => Promise<MeetingRecord | undefined>;
    segments: (id: string) => Promise<TranscriptSegment[]>;
  };
  people: Pick<People, 'observeAll'>;
  events: () => Promise<UpcomingEvent[]>;
  own: () => Promise<Set<string>>;
}

const defaultDeps: MeetDeps = {
  meetings: meetingStore,
  people,
  events: async () => (await upcomingEventsStore.get().catch(() => null))?.events ?? [],
  own: ownerEmails,
};

/** Learns the names of a finished call. Never throws on a missing meeting. */
export async function learnFromMeeting(meetingId: string, deps: MeetDeps = defaultDeps): Promise<void> {
  const meeting = await deps.meetings.get(meetingId);
  if (!meeting || meeting.status !== 'done') return;
  const segments = await deps.meetings.segments(meetingId);
  const invite = inviteFor(meeting, await deps.events());
  await deps.people.observeAll(meetingInputs(meeting, segments, invite, await deps.own()));
}
