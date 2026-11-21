import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AviCopilotDb, createPeopleStore } from '@extension/storage';
import type { InboxDraft } from '../../inbox/store';
import type { CardDeps } from '../cards';

vi.mock('@extension/i18n', () => ({ t: (key: string, values?: string[]) => [key, ...(values ?? [])].join(' ') }));

const { dailyCardId, likeOnCard, likelyPerson, MAX_QUESTIONS, postDailyCard, postMeetingCard } =
  await import('../cards');
const { createPeople } = await import('../people');

// Made-up people and workspaces only
const A = 'ws_alpha';
let people: ReturnType<typeof createPeople>;
let posted: InboxDraft[];
let deps: CardDeps;

beforeEach(() => {
  const store = createPeopleStore(new AviCopilotDb(`people-cards-${crypto.randomUUID()}`));
  people = createPeople(store);
  posted = [];
  deps = {
    store,
    addItem: async draft => void posted.push(draft),
    meetingTitle: async () => ({ title: 'Sync', workspaceId: A }),
  };
});

const slack = (text: string, day: string, handle = `D-${text}`) =>
  people.observe({
    text,
    source: 'slack',
    workspaceId: null,
    handle: { kind: 'slack', value: handle },
    ref: `slack-web|${handle}|${day}`,
    context: 'sent you a message on Slack',
  });

describe('the daily card', () => {
  it('a Slack name seen twice is on the day’s card, and the answer is remembered', async () => {
    await slack('Kemi Ade', '2026-11-20');
    // Seen once: no person and no question
    expect(await postDailyCard('2026-11-20', deps)).toBe(0);
    expect(await people.list()).toEqual([]);

    await slack('Kemi Ade', '2026-11-21');
    expect(await postDailyCard('2026-11-21', deps)).toBe(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ source: 'people', externalId: dailyCardId('2026-11-21'), kind: 'alert' });
    expect(posted[0].body).toContain('“Kemi Ade” — sent you a message on Slack');

    const [question] = await deps.store.onCard(dailyCardId('2026-11-21'));
    const { personId } = await people.answer(question.id, { kind: 'new', name: 'Kemi Adeyemi' });
    // Remembered: the same name, or the same DM under a new name, asks nothing again
    await slack('Kemi Ade', '2026-11-22');
    expect(
      await people.observe({
        text: 'K. Adeyemi',
        source: 'slack',
        workspaceId: null,
        handle: { kind: 'slack', value: 'D-Kemi Ade' },
        ref: 'x',
      }),
    ).toMatchObject({ kind: 'person', personId });
    expect(await postDailyCard('2026-11-23', deps)).toBe(0);
  });

  it('is posted once a day, with at most six questions; the rest wait for the next', async () => {
    const names = ['Amaka', 'Bisi', 'Chidi', 'Dayo', 'Efe', 'Femi', 'Gozie', 'Halima'];
    for (const name of names) {
      await slack(name, 'd1');
      await slack(name, 'd2');
    }
    expect(await postDailyCard('2026-11-21', deps)).toBe(MAX_QUESTIONS);
    expect(await postDailyCard('2026-11-21', deps)).toBe(0);
    expect(await postDailyCard('2026-11-22', deps)).toBe(names.length - MAX_QUESTIONS);
    expect(posted).toHaveLength(2);
  });

  it('never asks about a name marked "not a person"', async () => {
    await slack('standup-bot', 'd1');
    await slack('standup-bot', 'd2');
    await postDailyCard('2026-11-21', deps);
    const [question] = await deps.store.onCard(dailyCardId('2026-11-21'));
    await people.answer(question.id, { kind: 'not_person' });
    await slack('standup-bot', 'd3');
    await slack('standup-bot', 'd4', 'other-dm');
    expect(await postDailyCard('2026-11-22', deps)).toBe(0);
    expect(await people.list()).toEqual([]);
  });
});

describe('the card after a call', () => {
  it('asks about the call’s unsettled names and pairs a spoken name with the roster name it is short for', async () => {
    await people.observe({ text: 'Adaeze O.', source: 'meet', workspaceId: A, meetingId: 'm1', ref: 'm1' });
    await people.observe({ text: 'Ada', source: 'spoken', workspaceId: A, meetingId: 'm1', ref: 'm1', tasks: 2 });
    expect(await postMeetingCard('m1', deps)).toBe(2);
    expect(posted[0]).toMatchObject({ externalId: 'meeting:m1', workspaceId: A });
    const cards = await deps.store.onCard('meeting:m1');
    const ada = cards.find(candidate => candidate.text === 'Ada')!;
    const adaeze = cards.find(candidate => candidate.text === 'Adaeze O.')!;
    expect(ada.likeCandidateId).toBe(adaeze.id);

    const result = await people.answerLike(ada.id, adaeze.id);
    const person = await people.get(result.personId!);
    expect(person?.name).toBe('Adaeze O.');
    expect(person?.aliases.map(alias => alias.text)).toContain('Ada');
    // Nothing left to ask about that call
    expect(await postMeetingCard('m1', deps)).toBe(0);
  });
});

describe('what code offers', () => {
  const person = (id: string, name: string, workspaceIds: string[] = [A]) =>
    ({ id, name, aliases: [], handles: [], emails: [], phones: [], workspaceIds, seen: [] }) as never;

  it('offers the one person whose first name a handle carries, never one of two', () => {
    const candidate = { text: 'kunle-dev', otherTexts: [], workspaceId: A };
    expect(likelyPerson(candidate, [person('p1', 'Kunle A.'), person('p2', 'Tolu Bello')])?.id).toBe('p1');
    expect(likelyPerson(candidate, [person('p1', 'Kunle A.'), person('p3', 'Kunle Ojo')])).toBeNull();
    // Someone from another workspace is not offered
    expect(likelyPerson(candidate, [person('p1', 'Kunle A.', ['ws_beta'])])).toBeNull();
  });

  it('never offers someone through a name that holds in another workspace', () => {
    const kay = {
      ...(person('p1', 'Kehinde Ojo', [A, 'ws_beta']) as object),
      aliases: [{ text: 'Kay', workspaceId: A, from: 'avi' }],
    } as never;
    expect(likelyPerson({ text: 'Kay', otherTexts: [], workspaceId: 'ws_beta' }, [kay])).toBeNull();
    expect(likelyPerson({ text: 'Kay', otherTexts: [], workspaceId: A }, [kay])).not.toBeNull();
  });

  it('pairs a spoken name only when exactly one roster name starts that way', () => {
    const on = (id: string, text: string, source: 'meet' | 'spoken') =>
      ({ id, text, sightings: [{ source, at: 0 }], suggestedPersonId: null }) as never;
    expect(likeOnCard([on('a', 'Ada', 'spoken'), on('b', 'Adaeze O.', 'meet')]).get('a')).toBe('b');
    expect(
      likeOnCard([on('a', 'Ada', 'spoken'), on('b', 'Adaeze O.', 'meet'), on('c', 'Adanna K.', 'meet')]).has('a'),
    ).toBe(false);
  });
});
