import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AviCopilotDb } from '../../threads/db';
import { cleanName, cleanPhone, nameKey } from '../names';
import { createPeopleStore } from '../store';
import type { PeopleStore } from '../store';

// Made-up people and workspaces only
const A = 'ws_alpha';
const B = 'ws_beta';

let store: PeopleStore;

beforeEach(() => {
  store = createPeopleStore(new AviCopilotDb(`people-${crypto.randomUUID()}`));
});

const personIdOf = (result: Awaited<ReturnType<PeopleStore['observe']>>) =>
  result.kind === 'person' ? result.personId : null;

describe('names', () => {
  it('drops what a tool adds to a display name and ignores case and accents', () => {
    expect(cleanName('  Adaeze  Okafor (You) ')).toBe('Adaeze Okafor');
    expect(cleanName('Tolu (Presenting)')).toBe('Tolu');
    expect(nameKey('Adaéze OKAFOR')).toBe(nameKey('adaeze okafor'));
    expect(nameKey('"Kunle A."')).toBe('kunle a');
  });

  it('keeps phones as digits with their plus', () => {
    expect(cleanPhone('+234 801 234 5678')).toBe('+2348012345678');
    expect(cleanPhone('0044 20 7946 0000')).toBe('+442079460000');
    expect(cleanPhone('12')).toBeNull();
  });
});

describe('observe: a bare name', () => {
  it('seen once creates no person and no question', async () => {
    const result = await store.observe({ text: 'Bisi', source: 'slack', workspaceId: A, ref: 'item-1' });
    expect(result).toMatchObject({ kind: 'candidate', asking: false });
    expect(await store.list()).toHaveLength(0);
    expect(await store.readyToAsk()).toHaveLength(0);
  });

  it('seen again in the same thing still counts once', async () => {
    await store.observe({ text: 'Bisi', source: 'slack', workspaceId: A, ref: 'item-1' });
    await store.observe({ text: 'Bisi', source: 'slack', workspaceId: A, ref: 'item-1' });
    expect(await store.readyToAsk()).toHaveLength(0);
    expect((await store.unsettled())[0].count).toBe(1);
  });

  it('seen twice is asked about, with where it was seen', async () => {
    await store.observe({ text: 'Bisi', source: 'slack', workspaceId: A, ref: 'item-1', context: 'sent a message' });
    await store.observe({ text: 'bisi', source: 'slack', workspaceId: A, ref: 'item-2', context: 'sent 2 messages' });
    const [ready] = await store.readyToAsk();
    expect(ready.text).toBe('Bisi');
    expect(ready.count).toBe(2);
    expect(ready.sightings.map(sighting => sighting.context)).toEqual(['sent a message', 'sent 2 messages']);
  });

  it('seen once with a task is asked about at once', async () => {
    const result = await store.observe({ text: 'Chidi', source: 'spoken', workspaceId: A, taskId: 'task-1' });
    expect(result).toMatchObject({ kind: 'candidate', asking: true });
    expect((await store.readyToAsk())[0].taskIds).toEqual(['task-1']);
  });

  it('in two workspaces is two names, never one', async () => {
    await store.observe({ text: 'Bisi', source: 'slack', workspaceId: A, ref: '1' });
    await store.observe({ text: 'Bisi', source: 'slack', workspaceId: B, ref: '2' });
    expect(await store.readyToAsk()).toHaveLength(0);
    expect(await store.unsettled()).toHaveLength(2);
  });
});

describe('answers', () => {
  it('are remembered for that workspace and never asked again', async () => {
    await store.observe({ text: 'dev.kunle', source: 'slack', workspaceId: A, ref: '1' });
    await store.observe({ text: 'dev.kunle', source: 'slack', workspaceId: A, ref: '2' });
    const [question] = await store.readyToAsk();
    const { personId, created } = await store.answer(question.id, { kind: 'new', name: 'Kunle' });
    expect(created).toBe(true);

    const again = await store.observe({ text: 'dev.kunle', source: 'slack', workspaceId: A, ref: '3' });
    expect(personIdOf(again)).toBe(personId);
    expect(await store.readyToAsk()).toHaveLength(0);
    const kunle = await store.get(personId!);
    expect(kunle?.aliases).toEqual([{ text: 'dev.kunle', workspaceId: A, from: 'avi' }]);
    expect(kunle?.workspaceIds).toEqual([A]);
  });

  it('"Not a person" stops the name being asked about', async () => {
    await store.observe({ text: 'Launch Bot', source: 'slack', workspaceId: A, ref: '1' });
    await store.observe({ text: 'Launch Bot', source: 'slack', workspaceId: A, ref: '2' });
    const [question] = await store.readyToAsk();
    await store.answer(question.id, { kind: 'not_person' });
    for (const ref of ['3', '4', '5']) {
      expect(await store.observe({ text: 'launch bot', source: 'slack', workspaceId: A, ref })).toEqual({
        kind: 'ignored',
      });
    }
    expect(await store.readyToAsk()).toHaveLength(0);
    expect(await store.list()).toHaveLength(0);
  });

  it('link the tasks that waited on the name', async () => {
    await store.observe({ text: 'Chidi', source: 'spoken', workspaceId: A, taskId: 'task-1' });
    await store.observe({ text: 'Chidi', source: 'task', workspaceId: A, taskId: 'task-2' });
    const [question] = await store.readyToAsk();
    const answer = await store.answer(question.id, { kind: 'new', name: 'Chidi Eze' });
    expect(answer.taskIds).toEqual(['task-1', 'task-2']);
  });
});

describe('resolve', () => {
  it('an alias saved for one workspace never resolves in another', async () => {
    const ada = await store.create({ name: 'Adaeze Okafor', workspaceId: A });
    await store.addAlias(ada.id, 'Ada', A);
    expect(await store.resolve('Ada', { workspaceId: A })).toMatchObject({ person: { id: ada.id }, via: 'alias' });
    expect(await store.resolve('Ada', { workspaceId: B })).toBeNull();
    expect(await store.resolve('Ada', { workspaceId: null })).toBeNull();
    // Nor does seeing "Ada" in the other workspace touch her
    const seen = await store.observe({ text: 'Ada', source: 'slack', workspaceId: B, ref: 'x' });
    expect(seen.kind).toBe('candidate');
    expect((await store.get(ada.id))?.workspaceIds).toEqual([A]);
  });

  it('an alias for everywhere resolves in every workspace', async () => {
    const ada = await store.create({ name: 'Adaeze Okafor', workspaceId: A });
    await store.addAlias(ada.id, 'Ada O.', null);
    expect(await store.resolve('ada o', { workspaceId: B })).toMatchObject({ person: { id: ada.id } });
  });

  it('a name the owner gave in one workspace is neither resolved nor offered in another', async () => {
    await store.create({ name: 'Ada', workspaceId: A });
    expect(await store.resolve('Ada', { workspaceId: B })).toBeNull();
    await store.observe({ text: 'Ada', source: 'slack', workspaceId: B, ref: '1' });
    expect((await store.unsettled())[0].suggestedPersonId).toBeNull();
  });

  it('a unique first name resolves; two people sharing it are only candidates', async () => {
    const one = await store.create({ name: 'Ada Obi', workspaceId: A });
    expect(await store.resolve('Ada', { workspaceId: A })).toMatchObject({ person: { id: one.id }, via: 'first_name' });
    await store.create({ name: 'Ada Lovelace', workspaceId: A });
    const both = await store.resolve('Ada', { workspaceId: A });
    expect(both && 'candidates' in both ? both.candidates.length : 0).toBe(2);
    // Seeing "Ada" now asks, and joins neither
    await store.observe({ text: 'Ada', source: 'slack', workspaceId: A, ref: '1' });
    await store.observe({ text: 'Ada', source: 'slack', workspaceId: A, ref: '2' });
    const [question] = await store.readyToAsk();
    expect(question.candidatePersonIds).toHaveLength(2);
    expect((await store.get(one.id))?.aliases).toEqual([]);
  });
});

describe('identifiers', () => {
  it('a Gmail sender whose address matches a calendar attendee is the same person, with no question', async () => {
    // On the call and on its invite with an address: one question, and the owner's answer links the address
    await store.observe({ text: 'dev.kunle', source: 'meet', workspaceId: A, meetingId: 'm1', ref: 'm1' });
    await store.observe({
      text: 'dev.kunle',
      source: 'calendar',
      workspaceId: A,
      email: 'kunle@example.test',
      meetingId: 'm1',
      ref: 'm1',
    });
    const [question, ...more] = await store.readyToAsk();
    expect(more).toEqual([]);
    const { personId } = await store.answer(question.id, { kind: 'new', name: 'Kunle' });
    expect((await store.get(personId!))?.emails).toEqual(['kunle@example.test']);

    const gmail = await store.observe({
      text: 'Kunle A.',
      source: 'gmail',
      workspaceId: null,
      email: 'Kunle@Example.test',
      ref: 'thread-9',
    });
    expect(gmail).toMatchObject({ kind: 'person', personId, via: 'identifier' });
    expect(await store.unsettled()).toHaveLength(0);
    // The name it used is learned, for Kunle's own workspace
    expect(await store.resolve('Kunle A.', { workspaceId: A })).toMatchObject({ person: { id: personId } });
    expect(await store.resolve('Kunle A.', { workspaceId: B })).toBeNull();
  });

  it('before anyone is a person, an address joins two spellings into one question', async () => {
    await store.observe({
      text: 'Kunle Adebayo',
      source: 'calendar',
      workspaceId: null,
      email: 'kunle@example.test',
      ref: 'event-1',
    });
    await store.observe({
      text: 'Kunle A.',
      source: 'gmail',
      workspaceId: null,
      email: 'kunle@example.test',
      ref: 't',
    });
    const ready = await store.readyToAsk();
    expect(ready).toHaveLength(1);
    expect(ready[0].otherTexts.map(other => other.text)).toEqual(['Kunle A.']);
    const { personId } = await store.answer(ready[0].id, { kind: 'new', name: 'Kunle' });
    const kunle = await store.get(personId!);
    expect(kunle?.emails).toEqual(['kunle@example.test']);
    expect(kunle?.aliases.map(alias => alias.text).sort()).toEqual(['Kunle A.', 'Kunle Adebayo']);
  });

  it('a display name never hands someone a new address: it is offered instead', async () => {
    const ada = await store.create({ name: 'Adaeze Okafor', workspaceId: A, email: 'ada@example.test' });
    const spoof = await store.observe({
      text: 'Adaeze Okafor',
      source: 'gmail',
      workspaceId: A,
      email: 'someone@elsewhere.test',
      ref: 't1',
    });
    expect(spoof.kind).toBe('candidate');
    expect((await store.get(ada.id))?.emails).toEqual(['ada@example.test']);
    expect((await store.unsettled())[0].suggestedPersonId).toBe(ada.id);
  });

  it('a shared first name never moves an address', async () => {
    const ada = await store.create({ name: 'Ada Obi', workspaceId: A });
    await store.observe({ text: 'Ada', source: 'calendar', workspaceId: A, email: 'x@example.test' });
    expect((await store.get(ada.id))?.emails).toEqual([]);
  });

  it("an address that is someone else's wins over a name, and does not steal the alias", async () => {
    const ada = await store.create({ name: 'Ada Obi', workspaceId: A, alias: 'AO' });
    const tolu = await store.create({ name: 'Tolu Bello', workspaceId: A, email: 'tolu@example.test' });
    const result = await store.observe({ text: 'AO', source: 'gmail', workspaceId: A, email: 'tolu@example.test' });
    expect(personIdOf(result)).toBe(tolu.id);
    expect((await store.get(tolu.id))?.aliases).toEqual([]);
    expect(await store.resolve('AO', { workspaceId: A })).toMatchObject({ person: { id: ada.id } });
  });

  it('a Slack handle counts only in its workspace; a GitHub login counts everywhere', async () => {
    const ada = await store.create({ name: 'Ada Obi', workspaceId: A });
    await store.edit(ada.id, {
      handles: [
        { kind: 'slack', value: 'U01', workspaceId: A },
        { kind: 'github', value: 'adao', workspaceId: null },
      ],
    });
    expect(
      personIdOf(
        await store.observe({ text: 'x', source: 'slack', workspaceId: B, handle: { kind: 'slack', value: 'U01' } }),
      ),
    ).toBeNull();
    expect(
      personIdOf(
        await store.observe({ text: 'x', source: 'github', workspaceId: B, handle: { kind: 'github', value: 'adao' } }),
      ),
    ).toBe(ada.id);
  });
});

describe('merge', () => {
  it('moves aliases, handles, addresses and the names that pointed at the dropped person', async () => {
    const keep = await store.create({ name: 'Kunle', workspaceId: A, alias: 'dev.kunle' });
    const drop = await store.create({ name: 'Kunle Adebayo', workspaceId: B, email: 'kunle@example.test' });
    await store.addAlias(drop.id, 'KA', B);
    await store.edit(drop.id, { handles: [{ kind: 'github', value: 'kunle-dev', workspaceId: null }] });
    await store.observe({ text: 'Kunle Adebayo', source: 'slack', workspaceId: A, ref: '1' });

    const merged = await store.merge(keep.id, drop.id);
    expect(await store.get(drop.id)).toBeUndefined();
    expect(merged.emails).toEqual(['kunle@example.test']);
    expect(merged.handles).toEqual([{ kind: 'github', value: 'kunle-dev', workspaceId: null }]);
    expect(merged.workspaceIds.sort()).toEqual([A, B]);
    expect(merged.aliases).toEqual(
      expect.arrayContaining([
        { text: 'dev.kunle', workspaceId: A, from: 'avi' },
        // The dropped name keeps its reach: workspace B only
        { text: 'Kunle Adebayo', workspaceId: B, from: 'avi' },
        { text: 'KA', workspaceId: B, from: 'avi' },
      ]),
    );
    expect(await store.resolve('KA', { workspaceId: B })).toMatchObject({ person: { id: keep.id } });
    expect(await store.resolve('KA', { workspaceId: A })).toBeNull();
    expect((await store.unsettled()).every(candidate => candidate.suggestedPersonId !== drop.id)).toBe(true);
  });

  it('refuses to merge a person with themself', async () => {
    const ada = await store.create({ name: 'Ada', workspaceId: A });
    await expect(store.merge(ada.id, ada.id)).rejects.toThrow();
  });
});

describe('vocabulary seeds', () => {
  it("are a workspace's names and aliases, and never another workspace's aliases", async () => {
    const ada = await store.create({ name: 'Adaeze Okafor', workspaceId: A, alias: 'Ada' });
    await store.addAlias(ada.id, 'Adaa', B);
    await store.create({ name: 'Tolu Bello', workspaceId: B });
    expect((await store.vocabularySeeds(A)).sort()).toEqual(['Ada', 'Adaeze Okafor']);
  });
});

describe('remove', () => {
  it('unsettles the names that were settled as them', async () => {
    await store.observe({ text: 'Bisi', source: 'meet', workspaceId: A, meetingId: 'm', ref: 'm' });
    const [question] = await store.readyToAsk({ meetingId: 'm' });
    const { personId } = await store.answer(question.id, { kind: 'new', name: 'Bisi' });
    await store.remove(personId!);
    expect(await store.list()).toHaveLength(0);
    expect((await store.observe({ text: 'Bisi', source: 'slack', workspaceId: A, ref: 'z' })).kind).toBe('candidate');
  });
});

describe('forged or look-alike details', () => {
  it("a known address used with an open question's name only offers the person, and the tasks wait", async () => {
    const ada = await store.create({ name: 'Adaeze Okafor', workspaceId: A, email: 'ada@example.test' });
    await store.observe({ text: 'Chidi', source: 'spoken', workspaceId: A, taskId: 'task-1' });
    const forged = await store.observe({ text: 'Chidi', source: 'gmail', workspaceId: A, email: 'ada@example.test' });
    expect(forged).toMatchObject({ kind: 'person', personId: ada.id });
    expect((forged as { taskIds?: string[] }).taskIds).toBeUndefined();
    const [open] = await store.readyToAsk();
    expect(open).toMatchObject({ text: 'Chidi', status: 'ask', suggestedPersonId: ada.id, taskIds: ['task-1'] });
  });

  it('an invite name never adds a second address to someone who has one', async () => {
    const ada = await store.create({ name: 'Adaeze Okafor', workspaceId: A, email: 'ada@example.test' });
    await store.observe({
      text: 'Adaeze Okafor',
      source: 'calendar',
      workspaceId: A,
      email: 'evil@example.test',
    });
    expect((await store.get(ada.id))?.emails).toEqual(['ada@example.test']);
    expect((await store.unsettled())[0].suggestedPersonId).toBe(ada.id);
  });

  it('a name match never gives a known person an address, even one who has none', async () => {
    const ada = await store.create({ name: 'Ada Obi', workspaceId: A });
    await store.observe({ text: 'Ada Obi', source: 'meet', workspaceId: A, meetingId: 'm1', ref: 'm1' });
    await store.observe({ text: 'Ada Obi', source: 'calendar', workspaceId: A, email: 'mallory@evil.test', ref: 'm1' });
    expect((await store.get(ada.id))?.emails).toEqual([]);
    const payroll = await store.observe({
      text: 'Payroll',
      source: 'gmail',
      workspaceId: null,
      email: 'mallory@evil.test',
    });
    expect(personIdOf(payroll)).toBeNull();
  });

  it('two senders who share a display name are two questions, never one person with both addresses', async () => {
    const one = await store.observe({
      text: 'Ada',
      source: 'gmail',
      workspaceId: null,
      email: 'ada.obi@acme.test',
      ref: 'g1',
    });
    const two = await store.observe({
      text: 'Ada',
      source: 'gmail',
      workspaceId: null,
      email: 'mallory@evil.test',
      ref: 'g2',
    });
    expect(one.kind === 'candidate' && two.kind === 'candidate' && one.candidateId !== two.candidateId).toBe(true);
    const out = await store.answer((one as { candidateId: string }).candidateId, { kind: 'new', name: 'Ada Obi' });
    expect((await store.get(out.personId!))?.emails).toEqual(['ada.obi@acme.test']);
    // The second one comes back to the same question, not the first
    const again = await store.observe({
      text: 'Ada',
      source: 'gmail',
      workspaceId: null,
      email: 'mallory@evil.test',
      ref: 'g3',
    });
    expect(again).toMatchObject({ kind: 'candidate', candidateId: (two as { candidateId: string }).candidateId });
  });

  it('a settled name seen with a new handle is its own question; the answer stays', async () => {
    await store.observe({ text: 'Bisi', source: 'meet', workspaceId: A, meetingId: 'm', ref: 'm' });
    const [question] = await store.readyToAsk();
    const { personId } = await store.answer(question.id, { kind: 'new', name: 'Bisi Ade' });
    const seen = await store.observe({
      text: 'Bisi',
      source: 'slack',
      workspaceId: A,
      handle: { kind: 'slack', value: 'U9' },
    });
    expect(seen.kind).toBe('candidate');
    expect((await store.candidate(question.id))?.status).toBe('settled');
    expect((await store.candidate((seen as { candidateId: string }).candidateId))?.suggestedPersonId).toBe(personId);
  });
});

describe('workspaces never mix', () => {
  it("an inbox sender's name is saved for their person's workspaces, not everywhere", async () => {
    await store.create({ name: 'Ada Obi', workspaceId: A, email: 'ada.obi@acme.test' });
    const okafor = await store.create({ name: 'Ada Okafor', workspaceId: B });
    await store.observe({ text: 'Ada', source: 'gmail', workspaceId: null, email: 'ada.obi@acme.test' });
    expect(await store.resolve('Ada', { workspaceId: B })).toMatchObject({ person: { id: okafor.id } });
  });

  it("an answer to a question seen with no workspace is saved for that person's workspaces", async () => {
    const tolu = await store.create({ name: 'Tolu Bello', workspaceId: A });
    await store.observe({ text: 'TJ', source: 'slack', workspaceId: null, ref: 's1' });
    await store.observe({ text: 'TJ', source: 'slack', workspaceId: null, ref: 's2' });
    const [question] = await store.readyToAsk();
    await store.answer(question.id, { kind: 'same', personId: tolu.id });
    expect(await store.resolve('TJ', { workspaceId: A })).toMatchObject({ person: { id: tolu.id } });
    expect(await store.resolve('TJ', { workspaceId: B })).toBeNull();
  });

  it('a merge keeps a workspace-only name in its workspace', async () => {
    const keep = await store.create({ name: 'Adaeze Obi', workspaceId: A });
    const drop = await store.create({ name: 'Ada', workspaceId: A });
    const other = await store.create({ name: 'Ada Okafor', workspaceId: B });
    await store.merge(keep.id, drop.id);
    expect(await store.resolve('Ada', { workspaceId: B })).toMatchObject({ person: { id: other.id } });
    expect(await store.resolve('Ada', { workspaceId: A })).toMatchObject({ person: { id: keep.id } });
  });

  it('someone of that name in another workspace is not offered', async () => {
    await store.create({ name: 'Ada Obi', workspaceId: A });
    await store.observe({ text: 'Ada Obi', source: 'slack', workspaceId: B, ref: 's1' });
    expect((await store.unsettled())[0].suggestedPersonId).toBeNull();
  });
});

describe('cards', () => {
  it('two cards made at once never share a name, and one spelling is asked once a card', async () => {
    for (const ref of ['1', '2']) {
      await store.observe({ text: 'Kemi', source: 'slack', workspaceId: A, ref });
      await store.observe({ text: 'Kemi', source: 'slack', workspaceId: null, ref });
      await store.observe({ text: 'Femi', source: 'slack', workspaceId: null, ref });
    }
    const [first, second] = await Promise.all([store.claim('daily:1'), store.claim('daily:2')]);
    const ids = [...first, ...second].map(candidate => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const card of [first, second]) {
      const texts = card.map(candidate => candidate.text);
      expect(new Set(texts).size).toBe(texts.length);
    }
    expect(await store.claim('daily:1', { once: true })).toEqual([]);
  });
});
