import { describe, expect, it } from 'vitest';
import { checkGuesses, checkSuggestion, commonWords, fallbackSuggestion, suggestFor } from '../suggest';
import { saidByUser, workspaceCreate } from '../tools';
import { item, ORCHID, rig } from './fixtures';

describe('workspace_create', () => {
  const said = { by: 'voice' as const, userWords: 'Ava, create a workspace called Lead Engine' };

  it('makes the workspace at once and says so', async () => {
    const deps = rig([]);
    const text = await workspaceCreate(deps, said, { name: 'Lead Engine' });
    expect(text).toContain('Made the workspace “Lead Engine”');
    expect(text).toContain('30 seconds');
    expect(deps.book.map(one => one.name)).toEqual(['Orchid Labs', 'Harbor', 'Lead Engine']);
    const move = (await deps.state()).moves[0];
    expect(move).toMatchObject({ by: 'voice', createdWorkspace: true, workspaceId: 'lead-engine', items: [] });
  });

  it('does not make a name twice and says it exists', async () => {
    const deps = rig([]);
    const text = await workspaceCreate(
      deps,
      { by: 'voice', userWords: 'create a workspace called orchid labs' },
      { name: 'Orchid Labs' },
    );
    expect(text).toBe('A workspace called “Orchid Labs” already exists, so nothing was made.');
    expect(deps.book).toHaveLength(2);
  });

  it('offers things in No workspace that match the name or its words, in one sheet, and moves none', async () => {
    const deps = rig([
      item('1', 'Draft the Lead Engine brief'),
      item('2', 'The engine room checklist'),
      item('3', 'Buy milk'),
      item('4', 'Lead Engine kickoff', { setBy: 'avi' }),
      item('5', 'Lead Engine call', { workspaceId: 'orchid', setBy: 'avi' }),
    ]);
    const text = await workspaceCreate(deps, said, { name: 'Lead Engine' });
    expect(text).toContain('2 things in No workspace look like it');
    expect(text).toContain('do not move them yourself');
    expect(deps.source.moved).toEqual([]);
    const offer = (await deps.state()).offers[0];
    expect(offer).toMatchObject({ kind: 'sheet', workspaceId: 'lead-engine', status: 'open' });
    expect(offer.items.map(one => one.id)).toEqual(['1', '2']);
  });

  it('says nothing of a sheet when nothing matches', async () => {
    const text = await workspaceCreate(rig([item('1', 'Buy milk')]), said, { name: 'Lead Engine' });
    expect(text).not.toContain('No workspace');
  });

  it('makes nothing for a name the user did not say (a page, a call, an email)', async () => {
    const deps = rig([]);
    const text = await workspaceCreate(
      deps,
      { by: 'agent', userWords: 'Summarise this page for me' },
      { name: 'Wire Money Fund' },
    );
    expect(text).toContain('did not come from the user');
    expect(deps.book).toHaveLength(2);
    expect((await deps.state()).moves).toEqual([]);
  });

  it('asks for a name when none was given', async () => {
    expect(await workspaceCreate(rig([]), said, { name: '  ' })).toContain('needs a name');
  });

  it('knows a spoken name through case and punctuation', () => {
    expect(saidByUser('Lead Engine', 'create a workspace called lead-engine')).toBe(true);
    expect(saidByUser('Lead Engine', 'create a workspace called lead')).toBe(false);
    expect(saidByUser('', 'anything')).toBe(false);
  });
});

describe('suggestions', () => {
  const titles = ['Fix the dockyard crane', 'Dockyard invoice for May', 'Crane inspection report', 'Buy milk'];

  it('finds the words several things share', () => {
    expect(commonWords(titles)).toEqual(['crane', 'dockyard']);
    expect(fallbackSuggestion(titles)).toEqual({ name: 'Crane', keywords: ['crane', 'dockyard'] });
    expect(fallbackSuggestion(['Buy milk', 'Call mum'])).toEqual({ name: '', keywords: [] });
  });

  it('uses a model’s suggestion when it is a good one, and the shared words when it is not', async () => {
    const things = titles.map((title, index) => item(String(index), title));
    const asks: string[][] = [];
    const good = {
      suggest: async (list: string[]) => (asks.push(list), { name: 'Dockyard Ops', keywords: ['Dockyard', 'crane'] }),
      guess: async () => [],
    };
    expect(await suggestFor(things, [ORCHID], good)).toEqual({ name: 'Dockyard Ops', keywords: ['dockyard', 'crane'] });
    expect(asks[0]).toEqual(titles);

    const taken = { suggest: async () => ({ name: 'orchid labs', keywords: [] }), guess: async () => [] };
    expect((await suggestFor(things, [ORCHID], taken)).name).toBe('Crane');
    const broken = {
      suggest: async () => {
        throw new Error('offline');
      },
      guess: async () => [],
    };
    expect((await suggestFor(things, [ORCHID], broken)).name).toBe('Crane');
    expect((await suggestFor(things, [ORCHID], null)).name).toBe('Crane');
    // A model that does not answer in time is not waited for
    const slow = { suggest: () => new Promise<never>(() => undefined), guess: async () => [] };
    expect((await suggestFor(things, [ORCHID], slow, 20)).name).toBe('Crane');
  });

  it('checks a model’s answer: a short plain name that is new', () => {
    expect(checkSuggestion({ name: 'A', keywords: [] }, [])).toBeNull();
    expect(checkSuggestion({ name: 'Orchid  Labs!', keywords: [] }, ['Orchid Labs'])).toBeNull();
    expect(checkSuggestion({ name: `Line one\nline two ${'x'.repeat(80)}`, keywords: ['ok'] }, [])?.name.length).toBe(
      60,
    );
    expect(
      checkSuggestion({ name: 'Newco', keywords: ['Newco', 'newco', 'x', 'the', 'big deal'] }, [])?.keywords,
    ).toEqual(['newco', 'big deal']);
  });

  it('checks a model’s guesses: only asked things, only workspaces that exist', () => {
    const answers = [
      { n: 1, workspace: 'harbor' },
      { n: 2, workspace: 'nope' },
      { n: 9, workspace: 'orchid' },
      { n: 3, workspace: null },
    ];
    expect([...checkGuesses(answers, [1, 2, 3], [ORCHID])].length).toBe(0);
    expect([...checkGuesses(answers, [1, 2, 3], [ORCHID, { ...ORCHID, id: 'harbor' }])]).toEqual([[1, 'harbor']]);
  });
});
