import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AviCopilotDb, createPeopleStore } from '@extension/storage';
import type { MeetingRecord, TranscriptSegment, UpcomingEvent } from '@extension/storage';
import { learnFromCalendar } from '../calendar';
import { callKey, inviteFor, learnFromMeeting, meetingInputs } from '../meet';
import { createPeople } from '../people';
import type { People } from '../people';

// Made-up people, workspaces and calls only
const WS = 'ws_alpha';
const OWN = new Set(['owner@example.test']);
const URL1 = 'https://meet.google.com/abc-defg-hij';

let people: People;
beforeEach(() => {
  people = createPeople(createPeopleStore(new AviCopilotDb(`people-meet-${crypto.randomUUID()}`)));
});

const meeting = (id: string, over: Partial<MeetingRecord> = {}): MeetingRecord =>
  ({
    id,
    status: 'done',
    url: URL1,
    workspaceId: WS,
    roster: ['Adaeze O.', 'dev.kunle'],
    note: {
      title: 'Sync',
      tldr: [],
      decisions: [],
      openQuestions: [],
      participants: [],
      actionItems: [
        { owner: 'Ada', task: 'Write the release note', due: null },
        { owner: 'Ada', task: 'Book the demo', due: null },
        { owner: 'me', task: 'Send the deck', due: null },
        { owner: 'TBD', task: 'Find a venue', due: null },
      ],
    },
    ...over,
  }) as MeetingRecord;

const segments = (speakers: string[]) => speakers.map(speaker => ({ speaker }) as TranscriptSegment);

const invite: UpcomingEvent = {
  id: 'sync-1@20261123T090000Z',
  title: 'Sync',
  start: 0,
  end: 1,
  joinUrl: `${URL1}?authuser=0`,
  attendees: [
    { name: 'Adaeze O.', email: 'ada@example.test' },
    { name: 'Owner', email: 'owner@example.test' },
    { name: 'Tolu Bello', email: 'tolu@example.test' },
  ],
  organizer: { name: 'Owner', email: 'owner@example.test' },
};

function deps(record: MeetingRecord, lines: string[], events: UpcomingEvent[] = [invite]) {
  return {
    meetings: { get: async () => record, segments: async () => segments(lines) },
    people,
    events: async () => events,
    own: async () => OWN,
    card: async () => 0,
  };
}

describe('the invite a call belongs to', () => {
  it('is the one with the same meeting link, whatever its query', () => {
    expect(callKey('https://meet.google.com/abc-defg-hij/?authuser=1')).toBe('meet.google.com/abc-defg-hij');
    expect(inviteFor({ url: URL1 }, [{ id: 'x', joinUrl: 'https://meet.google.com/zzz-zzzz-zzz' }, invite])).toBe(
      invite,
    );
    expect(inviteFor({ url: URL1 }, [])).toBeNull();
  });
});

describe('meetingInputs', () => {
  it('tells the roster, the invite, the speakers and the task owners, never the owner himself', () => {
    const inputs = meetingInputs(meeting('m1'), segments(['Adaeze O.', 'Speaker 2', 'You', 'Adaeze O.']), invite, OWN);
    const lines = inputs.map(input => [input.source, input.text, input.email ?? null, input.trusted ?? false]);
    expect(lines).toEqual([
      ['meet', 'Adaeze O.', null, false],
      ['meet', 'dev.kunle', null, false],
      // The invitee who is a roster name gives that name its address, on the word of both
      ['calendar', 'Adaeze O.', 'ada@example.test', true],
      ['calendar', 'Tolu Bello', 'tolu@example.test', false],
      ['meet', 'Adaeze O.', null, false],
      ['spoken', 'Ada', null, false],
    ]);
    expect(inputs.at(-1)).toMatchObject({ tasks: 2, context: 'was given 2 tasks on the call', workspaceId: WS });
  });
});

describe('learning from calls', () => {
  it('asks about a first call, and a second call with the same people asks nothing', async () => {
    await learnFromMeeting('m1', deps(meeting('m1'), ['Adaeze O.', 'dev.kunle']));
    const asked = await people.store.readyToAsk({ meetingId: 'm1' });
    expect(asked.map(candidate => candidate.text).sort()).toEqual(['Ada', 'Adaeze O.', 'dev.kunle']);
    // Tolu was only on the invite: watched, not asked
    expect(asked.some(candidate => candidate.text === 'Tolu Bello')).toBe(false);

    const byText = (text: string) => asked.find(candidate => candidate.text === text)!;
    const { personId: adaeze } = await people.answer(byText('Adaeze O.').id, { kind: 'new', name: 'Adaeze Okafor' });
    await people.answer(byText('Ada').id, { kind: 'same', personId: adaeze! });
    await people.answer(byText('dev.kunle').id, { kind: 'new', name: 'Kunle' });
    expect((await people.get(adaeze!))?.emails).toEqual(['ada@example.test']);

    await learnFromMeeting('m2', deps(meeting('m2'), ['Adaeze O.', 'dev.kunle', 'Adaeze O.']));
    expect(await people.store.readyToAsk({ meetingId: 'm2' })).toEqual([]);
    expect(await people.store.readyToAsk()).toEqual([]);
  });

  it('learns nothing from a call that is not finished', async () => {
    await learnFromMeeting('m1', deps(meeting('m1', { status: 'recording' }), ['Adaeze O.']));
    expect(await people.store.unsettled()).toEqual([]);
  });

  it("a Gmail sender with an invitee's address joins that invitee, without a second question", async () => {
    await learnFromCalendar([{ ...invite, id: 'other-event@1' }], { people, own: async () => OWN });
    await people.observe({
      text: 'T. Bello',
      source: 'gmail',
      workspaceId: null,
      email: 'TOLU@example.test',
      ref: 'g1',
    });
    const open = await people.store.unsettled();
    const tolu = open.filter(candidate => candidate.emails.includes('tolu@example.test'));
    expect(tolu).toHaveLength(1);
    expect(tolu[0].otherTexts.map(other => other.text)).toEqual(['T. Bello']);
    // The owner is never on the list
    expect(open.some(candidate => candidate.emails.includes('owner@example.test'))).toBe(false);
  });

  it('an invite read again on the next calendar check is not a second sighting', async () => {
    const event = { ...invite, id: 'again@1' };
    expect(await learnFromCalendar([event], { people, own: async () => OWN })).toBe(2);
    expect(await learnFromCalendar([event], { people, own: async () => OWN })).toBe(0);
  });
});
