import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AviCopilotDb, createPeopleStore } from '@extension/storage';
import { personNote } from '../note';
import { createPeople } from '../people';

// Made-up people and workspaces only
const A = 'ws_alpha';
let people: ReturnType<typeof createPeople>;
beforeEach(() => {
  people = createPeople(createPeopleStore(new AviCopilotDb(`people-note-${crypto.randomUUID()}`)));
});

describe('person_note', () => {
  it('creates a new person from the owner’s own word, then adds to them', async () => {
    expect(await personNote({ name: 'Tolu Bello', note: 'Runs design', workspaceId: A }, people)).toContain('Added');
    await personNote({ name: 'Tolu Bello', alias: 'TB', email: 'tolu@example.test', workspaceId: A }, people);
    const [tolu] = await people.list();
    expect(tolu).toMatchObject({ name: 'Tolu Bello', about: 'Runs design', emails: ['tolu@example.test'] });
    expect(tolu.aliases).toEqual([expect.objectContaining({ text: 'TB', workspaceId: A })]);
    // The alias is this workspace's only
    expect(await people.resolve('TB', { workspaceId: 'ws_beta' })).toBeNull();
  });

  it('asks which one when two people share the name', async () => {
    await people.create({ name: 'Kunle Ojo', workspaceId: A });
    await people.create({ name: 'Kunle Ade', workspaceId: A });
    expect(await personNote({ name: 'Kunle', note: 'x', workspaceId: A }, people)).toContain('Several people');
  });

  it('from a typed chat, takes only names and addresses the owner wrote himself', async () => {
    const said = await personNote(
      { name: 'Ada Obi', email: 'ada@evil.test', workspaceId: A, userWords: 'Ada Obi runs sales' },
      people,
    );
    expect(said).toContain('did not write');
    expect(await people.list()).toEqual([]);
    await personNote({ name: 'Ada Obi', note: 'Runs sales', workspaceId: A, userWords: 'Ada Obi runs sales' }, people);
    expect((await people.list()).map(person => person.name)).toEqual(['Ada Obi']);
  });

  it('refuses an address that is not one', async () => {
    expect(await personNote({ name: 'Ada', email: 'not an email', workspaceId: A }, people)).toContain('not an email');
  });
});
