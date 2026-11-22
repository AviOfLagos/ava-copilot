import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AviCopilotDb } from '../../threads/db';
import { createPersonUpdateStore } from '../store';
import type { PersonUpdateStore } from '../store';
import { newPersonUpdateId, personUpdateIdOf, PERSON_UPDATE_ID_PATTERN } from '../types';
import type { PersonUpdate } from '../types';

const T = (day: number, hour = 9) => new Date(2026, 10, day, hour).getTime();

let store: PersonUpdateStore;

beforeEach(() => {
  store = createPersonUpdateStore(new AviCopilotDb(`followups-${crypto.randomUUID()}`));
});

const update = (fields: Partial<PersonUpdate> = {}): PersonUpdate => ({
  id: 'pu_aaaaaaaaaa',
  personId: 'p-ada',
  name: 'Ada',
  workspaceId: 'w1',
  did: [],
  doing: ['the deck'],
  next: [],
  blockers: [],
  source: { kind: 'meeting', id: 'm1' },
  at: T(23),
  ...fields,
});

describe('ids', () => {
  it('are pu_ + 10 base32 chars, random or from the parts', () => {
    expect(newPersonUpdateId()).toMatch(PERSON_UPDATE_ID_PATTERN);
    expect(personUpdateIdOf('meeting', 'm1', 'ada')).toMatch(PERSON_UPDATE_ID_PATTERN);
  });
  it('the same parts give the same id, different parts another', () => {
    expect(personUpdateIdOf('meeting', 'm1', 'ada')).toBe(personUpdateIdOf('meeting', 'm1', 'ada'));
    expect(personUpdateIdOf('meeting', 'm1', 'ada')).not.toBe(personUpdateIdOf('meeting', 'm1', 'ben'));
    expect(personUpdateIdOf('meeting', 'm1', 'ada')).not.toBe(personUpdateIdOf('meeting', 'm2', 'ada'));
  });
});

describe('save', () => {
  it('cleans the lists and the name', async () => {
    const saved = await store.save(
      update({ name: '  Ada   Example ', doing: ['  the   deck ', '', '   '], did: ['x'.repeat(400)], byText: '' }),
    );
    expect(saved.name).toBe('Ada Example');
    expect(saved.doing).toEqual(['the deck']);
    expect(saved.did[0]).toHaveLength(300);
    expect(saved).not.toHaveProperty('byText');
    expect(await store.get(saved.id)).toEqual(saved);
  });

  it("keeps Avi's earlier offer answers when the same id is saved again", async () => {
    const offers = [
      { taskId: 'tsk_a', said: 'sent the deck' },
      { taskId: 'tsk_b', said: 'fixed the login' },
    ];
    await store.save(update({ offers }));
    await store.answerOffer('pu_aaaaaaaaaa', 'tsk_a', 'no', T(23, 12));
    const again = await store.save(update({ offers: [...offers, { taskId: 'tsk_c', said: 'paid the venue' }] }));
    expect(again.offers).toEqual([
      { taskId: 'tsk_a', said: 'sent the deck', answer: 'no', answeredAt: T(23, 12) },
      { taskId: 'tsk_b', said: 'fixed the login' },
      { taskId: 'tsk_c', said: 'paid the venue' },
    ]);
  });

  it('keeps the earlier offers when saved again without any', async () => {
    await store.save(update({ offers: [{ taskId: 'tsk_a', said: 'sent the deck' }] }));
    const again = await store.save(update());
    expect(again.offers).toEqual([{ taskId: 'tsk_a', said: 'sent the deck' }]);
  });

  it('the same id replaces the record, not adds one', async () => {
    await store.save(update({ doing: ['one'] }));
    await store.save(update({ doing: ['two'] }));
    expect(await store.forPerson('p-ada')).toHaveLength(1);
    expect((await store.get('pu_aaaaaaaaaa'))!.doing).toEqual(['two']);
  });
});

describe('forPerson', () => {
  it("is newest first, and only that person's", async () => {
    await store.save(update({ id: 'pu_1', at: T(20) }));
    await store.save(update({ id: 'pu_3', at: T(24) }));
    await store.save(update({ id: 'pu_2', at: T(22) }));
    await store.save(update({ id: 'pu_x', personId: 'p-ben', at: T(25) }));
    expect((await store.forPerson('p-ada')).map(item => item.id)).toEqual(['pu_3', 'pu_2', 'pu_1']);
    expect((await store.forPerson('p-ada', 2)).map(item => item.id)).toEqual(['pu_3', 'pu_2']);
    expect(await store.forPerson('nobody')).toEqual([]);
  });
});

describe('forSource', () => {
  it("returns one meeting's updates, in the order said", async () => {
    await store.save(update({ id: 'pu_b', name: 'Ben', source: { kind: 'meeting', id: 'm1' }, at: T(23, 10) }));
    await store.save(update({ id: 'pu_a', name: 'Ada', source: { kind: 'meeting', id: 'm1' }, at: T(23, 9) }));
    await store.save(update({ id: 'pu_c', name: 'Cleo', source: { kind: 'meeting', id: 'm2' } }));
    await store.save(update({ id: 'pu_w', name: 'Wes', source: { kind: 'whatsapp', id: 'm1' } }));
    expect((await store.forSource('meeting', 'm1')).map(item => item.id)).toEqual(['pu_a', 'pu_b']);
    expect((await store.forSource('whatsapp', 'm1')).map(item => item.id)).toEqual(['pu_w']);
    expect(await store.forSource('meeting', 'none')).toEqual([]);
  });
});

describe('since', () => {
  it('is oldest first from a moment on', async () => {
    await store.save(update({ id: 'pu_1', at: T(20) }));
    await store.save(update({ id: 'pu_3', at: T(24) }));
    await store.save(update({ id: 'pu_2', at: T(22) }));
    expect((await store.since(T(22))).map(item => item.id)).toEqual(['pu_2', 'pu_3']);
  });
});

describe('answerOffer', () => {
  it('records the answer and the time on that offer only', async () => {
    await store.save(
      update({
        offers: [
          { taskId: 'tsk_a', said: 'x' },
          { taskId: 'tsk_b', said: 'y' },
        ],
      }),
    );
    const answered = await store.answerOffer('pu_aaaaaaaaaa', 'tsk_b', 'done', T(24));
    expect(answered!.offers).toEqual([
      { taskId: 'tsk_a', said: 'x' },
      { taskId: 'tsk_b', said: 'y', answer: 'done', answeredAt: T(24) },
    ]);
    expect((await store.get('pu_aaaaaaaaaa'))!.offers![1].answer).toBe('done');
  });

  it('returns null when the update or the offer is gone', async () => {
    expect(await store.answerOffer('pu_missing', 'tsk_a', 'done', T(24))).toBeNull();
    await store.save(update({ offers: [{ taskId: 'tsk_a', said: 'x' }] }));
    expect(await store.answerOffer('pu_aaaaaaaaaa', 'tsk_zzz', 'done', T(24))).toBeNull();
  });
});

describe('link', () => {
  it('links updates said under a name, in that workspace only', async () => {
    await store.save(update({ id: 'pu_1', personId: null, name: 'Ada', workspaceId: 'w1' }));
    await store.save(update({ id: 'pu_2', personId: null, name: 'ada', workspaceId: 'w1' }));
    await store.save(update({ id: 'pu_3', personId: null, name: 'Ada', workspaceId: 'w2' }));
    await store.save(update({ id: 'pu_4', personId: null, name: 'Ben', workspaceId: 'w1' }));
    await store.save(update({ id: 'pu_5', personId: 'p-other', name: 'Ada', workspaceId: 'w1' }));
    await store.save(update({ id: 'pu_6', personId: null, name: 'Ada', workspaceId: null }));
    expect(await store.link(['Ada'], 'p-ada', 'w1')).toBe(2);
    const personIds = Object.fromEntries(
      await Promise.all(
        ['pu_1', 'pu_2', 'pu_3', 'pu_4', 'pu_5', 'pu_6'].map(async id => [id, (await store.get(id))!.personId]),
      ),
    );
    expect(personIds).toEqual({
      pu_1: 'p-ada',
      pu_2: 'p-ada',
      pu_3: null,
      pu_4: null,
      pu_5: 'p-other',
      pu_6: null,
    });
  });

  it('links in no workspace when null is given', async () => {
    await store.save(update({ id: 'pu_1', personId: null, name: 'Ada', workspaceId: null }));
    await store.save(update({ id: 'pu_2', personId: null, name: 'Ada', workspaceId: 'w1' }));
    expect(await store.link(['Ada'], 'p-ada', null)).toBe(1);
  });

  it('does nothing with no usable names', async () => {
    await store.save(update({ personId: null }));
    expect(await store.link([], 'p', 'w1')).toBe(0);
    expect(await store.link(['', '  '], 'p', 'w1')).toBe(0);
  });
});

describe('replacePerson', () => {
  it("re-points a merged person's updates", async () => {
    await store.save(update({ id: 'pu_1', personId: 'p-old' }));
    await store.save(update({ id: 'pu_2', personId: 'p-old' }));
    await store.save(update({ id: 'pu_3', personId: 'p-keep' }));
    expect(await store.replacePerson('p-old', 'p-new')).toBe(2);
    expect((await store.forPerson('p-new')).map(item => item.id).sort()).toEqual(['pu_1', 'pu_2']);
    expect(await store.forPerson('p-old')).toEqual([]);
    expect(await store.forPerson('p-keep')).toHaveLength(1);
  });

  it("a removed person's updates keep their name and lose the link", async () => {
    await store.save(update({ id: 'pu_1', personId: 'p-old', name: 'Ada' }));
    await store.replacePerson('p-old', null);
    const kept = await store.get('pu_1');
    expect(kept).toMatchObject({ personId: null, name: 'Ada' });
  });
});
