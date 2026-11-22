import { describe, expect, it } from 'vitest';
import type { NoteUpdate, ObserveInput, PersonUpdate, Task, TaskListQuery } from '@extension/storage';
import { makeTask, nov } from './helpers';
import { ownerNamesOf } from '../owner';
import { recordMeetingUpdates, speakerKeys, updatesToKeep } from '../updates';
import type { UpdateDeps } from '../updates';

const MEETING = { id: 'm1', startedAt: nov(23, 10), endedAt: nov(23, 11), workspaceId: 'w1' };
const owner = ownerNamesOf('Avi Example');

const entry = (name: string, fields: Partial<NoteUpdate> = {}): NoteUpdate => ({
  name,
  did: [],
  doing: [],
  next: [],
  by: null,
  blockers: [],
  ...fields,
});
const speech = (...speakers: string[]) => speakers.map(speaker => ({ speaker }));

const IDS: Record<string, string> = { ada: 'p-ada', ben: 'p-ben' };

function setup(tasks: Task[] = []) {
  const saved = new Map<string, PersonUpdate>();
  const observed: ObserveInput[] = [];
  const listed: TaskListQuery[] = [];
  const mutated: string[] = [];
  const deps: UpdateDeps = {
    people: {
      async resolve(text) {
        const id = IDS[text.trim().toLowerCase().split(' ')[0]];
        return id ? { person: { id, name: text } as never, via: 'name' } : null;
      },
      async observe(input) {
        observed.push(input);
        return { kind: 'candidate', candidateId: 'c1', asking: true } as never;
      },
    },
    tasks: {
      async list(query) {
        listed.push(query);
        return tasks.filter(
          task => (!query.status || task.status === query.status) && (!query.ownerId || task.ownerId === query.ownerId),
        );
      },
      // Anything else on the store would be a bug here: updates only list
      ...({
        setStatus: () => mutated.push('setStatus'),
        update: () => mutated.push('update'),
      } as object),
    },
    updates: {
      async save(update) {
        saved.set(update.id, update);
        return update;
      },
    },
    owner: async () => owner,
  };
  return { deps, saved, observed, listed, mutated };
}

describe('speakerKeys', () => {
  it('is null when any line has no real name', () => {
    expect(speakerKeys(speech('Ada Example', 'Speaker 2'))).toBeNull();
    expect(speakerKeys([])).toBeNull();
  });
  it('holds each speaker and their first name', () => {
    expect([...speakerKeys(speech('Ada Example'))!].sort()).toEqual(['ada', 'ada example']);
  });
});

describe('updatesToKeep', () => {
  const keep = (updates: NoteUpdate[], segments = speech()) =>
    updatesToKeep({ personUpdates: updates }, segments, owner);

  it('drops entries with nothing said, Avi himself, and "the team"', () => {
    const kept = keep([
      entry('Ada', { doing: ['the deck'] }),
      entry('Ben'),
      entry('Avi', { doing: ['the site'] }),
      entry('Avi Example', { doing: ['the site'] }),
      entry('me', { doing: ['the site'] }),
      entry('the team', { doing: ['stuff'] }),
    ]);
    expect(kept.map(update => update.name)).toEqual(['Ada']);
  });

  it('with caption speakers known, a name that never spoke is dropped', () => {
    const segments = speech('Ada Example', 'Avi Example');
    const kept = keep([entry('Ada', { doing: ['x'] }), entry('Cleo', { doing: ['y'] })], segments);
    expect(kept.map(update => update.name)).toEqual(['Ada']);
  });

  it("with generic speakers, the model's reading stands", () => {
    const kept = keep([entry('Cleo', { doing: ['y'] })], speech('Speaker 1', 'Speaker 2'));
    expect(kept.map(update => update.name)).toEqual(['Cleo']);
  });

  it('merges two entries for one name', () => {
    const kept = keep([entry('Ada', { did: ['a'], by: 'Thursday' }), entry('ada', { doing: ['b'], did: ['c'] })]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ did: ['a', 'c'], doing: ['b'], by: 'Thursday' });
  });

  it('keeps nothing when the note has no updates', () => {
    expect(updatesToKeep({}, [], owner)).toEqual([]);
    expect(keep([])).toEqual([]);
  });
});

describe('recordMeetingUpdates', () => {
  it('two people give updates: two records with the right person and by', async () => {
    const s = setup();
    const records = await recordMeetingUpdates(
      MEETING,
      {
        personUpdates: [
          entry('Ada', { doing: ['the deck'], next: ['send it'], by: 'Thursday' }),
          entry('Ben', { did: ['the login'] }),
        ],
      },
      speech('Ada Example', 'Ben Example', 'Avi Example'),
      s.deps,
    );
    expect(records).toHaveLength(2);
    const [ada, ben] = records;
    expect(ada).toMatchObject({
      personId: 'p-ada',
      name: 'Ada',
      workspaceId: 'w1',
      doing: ['the deck'],
      byText: 'Thursday',
      by: '2026-11-26',
      source: { kind: 'meeting', id: 'm1' },
      at: MEETING.startedAt,
    });
    expect(ben).toMatchObject({ personId: 'p-ben', did: ['the login'] });
    expect(ben).not.toHaveProperty('by');
    expect(s.saved.size).toBe(2);
  });

  it.each([
    ['Friday', '2026-11-27'],
    ['tomorrow', '2026-11-24'],
    ['2026-12-02', '2026-12-02'],
  ])('"%s" said on Mon 23 Nov is %s', async (words, by) => {
    const s = setup();
    const [record] = await recordMeetingUpdates(
      MEETING,
      { personUpdates: [entry('Ada', { next: ['x'], by: words })] },
      [],
      s.deps,
    );
    expect(record.by).toBe(by);
  });

  it('a name only talked about gets no record (captions known, it never spoke)', async () => {
    const s = setup();
    const records = await recordMeetingUpdates(
      MEETING,
      { personUpdates: [entry('Cleo', { doing: ['something'] })] },
      speech('Ada Example', 'Avi Example'),
      s.deps,
    );
    expect(records).toEqual([]);
    expect(s.saved.size).toBe(0);
    expect(s.observed).toEqual([]);
  });

  it('nobody gave an update: nothing is saved', async () => {
    const s = setup();
    expect(await recordMeetingUpdates(MEETING, { personUpdates: [] }, [], s.deps)).toEqual([]);
    expect(await recordMeetingUpdates(MEETING, {}, [], s.deps)).toEqual([]);
    expect(s.saved.size).toBe(0);
  });

  it("Avi's own update is skipped", async () => {
    const s = setup();
    const records = await recordMeetingUpdates(
      MEETING,
      { personUpdates: [entry('Avi', { doing: ['the site'] }), entry('Ada', { doing: ['the deck'] })] },
      [],
      s.deps,
    );
    expect(records.map(record => record.name)).toEqual(['Ada']);
  });

  it('recording the same call twice keeps the same ids', async () => {
    const s = setup();
    const note = { personUpdates: [entry('Ada', { doing: ['x'] }), entry('Ben', { doing: ['y'] })] };
    const first = await recordMeetingUpdates(MEETING, note, [], s.deps);
    const second = await recordMeetingUpdates(MEETING, note, [], s.deps);
    expect(second.map(record => record.id)).toEqual(first.map(record => record.id));
    expect(s.saved.size).toBe(2);
  });

  it('a name People does not know is observed under the call, and saved without a person', async () => {
    const s = setup();
    const [record] = await recordMeetingUpdates(
      MEETING,
      { personUpdates: [entry('Zed', { doing: ['x'] })] },
      [],
      s.deps,
    );
    expect(record.personId).toBeNull();
    expect(s.observed).toEqual([expect.objectContaining({ text: 'Zed', meetingId: 'm1', ref: 'meet:m1' })]);
  });

  it('a "did" matching an open task of that person becomes an offer; the task is not closed', async () => {
    const task = makeTask({ id: 'tsk_deck', ownerId: 'p-ada', title: 'Send the deck to the venue' });
    const s = setup([task]);
    const [record] = await recordMeetingUpdates(
      MEETING,
      { personUpdates: [entry('Ada', { did: ['I sent the deck to the venue'] })] },
      [],
      s.deps,
    );
    expect(record.offers).toEqual([{ taskId: 'tsk_deck', said: 'I sent the deck to the venue' }]);
    expect(s.mutated).toEqual([]);
    expect(task.status).toBe('open');
  });

  it('a task made by this same meeting is not offered', async () => {
    const own = makeTask({
      id: 'tsk_new',
      ownerId: 'p-ada',
      title: 'Send the deck to the venue',
      source: { kind: 'meeting', id: 'm1' },
    });
    const earlier = makeTask({
      id: 'tsk_old',
      ownerId: 'p-ada',
      title: 'Fix the login page',
      source: { kind: 'meeting', id: 'm0' },
    });
    const s = setup([own, earlier]);
    const [record] = await recordMeetingUpdates(
      MEETING,
      { personUpdates: [entry('Ada', { did: ['sent the deck to the venue', 'fixed the login page'] })] },
      [],
      s.deps,
    );
    expect(record.offers).toEqual([{ taskId: 'tsk_old', said: 'fixed the login page' }]);
  });
});
