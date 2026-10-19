import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StorageModule from '@extension/storage';
import type { KnowledgeItem } from '@extension/storage';

// Private and team memory for agents: agent A never reads agent B's private memory by search, ask, graph
// or a crafted id; Ava (the user's chats, voice, the panel) reads all of it; a routine reads team + unowned.

vi.mock('@extension/storage', async original => ({
  ...(await original<typeof StorageModule>()),
  kbSettingsStore: {
    getSettings: async () => ({
      indexChats: true,
      indexMeetings: true,
      buildGraph: false,
      retentionDays: 0,
      embedModel: 'none',
      embedDimensions: 32,
      embedSource: 'auto',
      localEmbedModel: 'none',
    }),
  },
}));

const prompts: string[] = [];
vi.mock('../../llm/generate', () => ({
  generatePlainText: async ({ messages }: { messages: { content: string }[] }) => {
    prompts.push(String(messages.at(-1)?.content));
    return 'An answer [1]';
  },
}));
vi.mock('../../threads/factory', () => ({ resolveModels: async () => ({}) }));

const { db, graphStore, kbStore, threadStore } = await import('@extension/storage');
const { KnowledgeBase } = await import('../manager');
const { setKnowledgeBase } = await import('../shared');
const { canSee, itemScope, memoryScope, memoryScopeFor, memoryScopeForThread, saveFieldsFor } =
  await import('../scope');
const { saveKnowledgeAction, searchKnowledgeAction, shareWithTeamAction } = await import('../action');
const { lookUpGraphAction } = await import('../../graph/action');
const { itemsOf } = await import('../../history/rollup');

const W = 'w1';
const SECRETS = {
  aPrivate: 'bluebird',
  bPrivate: 'ninetythousand',
  team: 'tuesdaystandup',
  unowned: 'morningperson',
  legacyB: 'ospreyfalls',
  otherWorkspace: 'elsewhereword',
} as const;

let kb: InstanceType<typeof KnowledgeBase>;
const ids: Record<keyof typeof SECRETS, string> = {} as never;
const threads: Record<'a' | 'b' | 'ava' | 'routine' | 'voice', string> = {} as never;

function context(taskId: string) {
  return {
    taskId,
    emitEvent: vi.fn(async () => {}),
    browserContext: { getCurrentPage: async () => ({ tabId: 1 }) },
  } as never;
}

/** What search_knowledge found, without the query it echoes when it finds nothing. */
async function searchAs(thread: string, query: string): Promise<string> {
  const result = await searchKnowledgeAction(context(thread), { intent: '', query });
  const text = String(result.extractedContent);
  return text.includes('has nothing matching') ? '' : text;
}

async function graphAs(thread: string, name: string): Promise<string> {
  const result = await lookUpGraphAction(context(thread), { intent: '', name });
  return String(result.extractedContent);
}

async function note(text: string, owner: { agentId?: string | null; scope?: KnowledgeItem['scope'] }, ws = W) {
  return (await kb.saveNote(text, text, ws, owner)).id;
}

beforeEach(async () => {
  vi.stubGlobal('chrome', { i18n: { getMessage: (key: string) => key } });
  await Promise.all([db.kbItems.clear(), db.kbChunks.clear(), db.graphNodes.clear(), db.graphEdges.clear()]);
  await db.threads.clear();
  prompts.length = 0;
  kb = new KnowledgeBase({
    embedder: async () => null,
    answerModel: async () => ({}) as never,
    overCap: async () => false,
  });
  setKnowledgeBase(kb);

  threads.a = (await threadStore.create({ workspaceId: W, agentId: 'scout', origin: 'agent' })).id;
  threads.b = (await threadStore.create({ workspaceId: W, agentId: 'writer', origin: 'agent' })).id;
  threads.ava = (await threadStore.create({ workspaceId: W, origin: 'user' })).id;
  // A routine that runs as an agent still reads only the team's and the user's memory
  threads.routine = (await threadStore.create({ workspaceId: W, agentId: 'scout', origin: 'workflow' })).id;
  threads.voice = (await threadStore.create({ workspaceId: W, origin: 'voice' })).id;

  ids.aPrivate = await note(`Falcon codename ${SECRETS.aPrivate}`, saveFieldsFor(memoryScope.agent(W, 'scout')));
  ids.bPrivate = await note(`Heron budget ${SECRETS.bPrivate}`, saveFieldsFor(memoryScope.agent(W, 'writer')));
  ids.team = await note(`Standup ${SECRETS.team}`, saveFieldsFor(memoryScope.agent(W, 'scout'), true));
  ids.unowned = await note(`Avi is a ${SECRETS.unowned}`, saveFieldsFor(memoryScope.ava(W)));
  ids.otherWorkspace = await note(`Other ${SECRETS.otherWorkspace}`, {}, 'w2');
  // Written before scopes existed: an agent's item with no scope is that agent's own
  const legacy = { ...(await kbStore.item(await note(`Legacy ${SECRETS.legacyB}`, {})))! };
  await db.kbItems.put({ ...legacy, agentId: 'writer' });
  ids.legacyB = legacy.id;

  // Graph: Falcon only in A's private note; Ada in B's private note and in the team note
  const slice = (itemId: string, title: string, entities: { id: string; label: string }[]) =>
    graphStore.replace({
      source: { id: itemId, type: 'note', label: title, workspaceId: W, sourceItemIds: [], date: 1, updatedAt: 1 },
      entities: entities.map(e => ({
        id: e.id,
        type: 'person',
        label: e.label,
        workspaceId: W,
        sourceItemIds: [],
        date: 1,
        updatedAt: 1,
      })),
      edges: entities.map(e => ({ from: itemId, to: e.id, kind: 'mentions' as const })),
    });
  await slice(ids.aPrivate, 'Falcon codename', [{ id: `person:${W}:falcon`, label: 'Falcon' }]);
  await slice(ids.bPrivate, 'Heron budget', [{ id: `person:${W}:ada`, label: 'Ada' }]);
  await slice(ids.team, 'Standup', [{ id: `person:${W}:ada`, label: 'Ada' }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Who sees which kind of item: agent A (scout), agent B (writer), Ava, a routine
const MATRIX: Record<keyof typeof SECRETS, Record<'a' | 'b' | 'ava' | 'routine', boolean>> = {
  aPrivate: { a: true, b: false, ava: true, routine: false },
  bPrivate: { a: false, b: true, ava: true, routine: false },
  team: { a: true, b: true, ava: true, routine: true },
  unowned: { a: true, b: true, ava: true, routine: true },
  legacyB: { a: false, b: true, ava: true, routine: false },
  // Workspaces never mix
  otherWorkspace: { a: false, b: false, ava: false, routine: false },
};
const CALLERS = ['a', 'b', 'ava', 'routine'] as const;

describe('memory scope matrix', () => {
  for (const [kind, row] of Object.entries(MATRIX) as [keyof typeof SECRETS, (typeof MATRIX)['team']][]) {
    for (const caller of CALLERS) {
      const sees = row[caller];
      it(`${caller} ${sees ? 'finds' : 'never finds'} the ${kind} item: search, ask, by id`, async () => {
        const word = SECRETS[kind];
        // search_knowledge from the caller's own chat
        expect((await searchAs(threads[caller], word)).includes(word)).toBe(sees);
        // ask: the sources the answer model is given
        prompts.length = 0;
        await kb.ask(word, await memoryScopeForThread(threads[caller]));
        expect(prompts.join('\n').includes(word)).toBe(sees);
        // A crafted id
        expect(Boolean(await kb.item(ids[kind], await memoryScopeForThread(threads[caller])))).toBe(sees);
      });
    }
  }

  it('the voice conversation is Ava in its own workspace', async () => {
    const scope = await memoryScopeForThread(threads.voice);
    expect(scope).toEqual({ caller: 'ava', workspaceId: W, agentId: null });
    prompts.length = 0;
    await kb.ask(SECRETS.bPrivate, scope);
    expect(prompts.join()).toContain(SECRETS.bPrivate);
    await kb.ask(SECRETS.otherWorkspace, scope);
    expect(prompts.join()).not.toContain(SECRETS.otherWorkspace);
  });

  it('an unknown chat gets the least: no private memory', async () => {
    expect((await memoryScopeForThread('nope')).caller).toBe('routine');
    expect(memoryScopeFor(undefined).caller).toBe('ava');
  });
});

describe('graph', () => {
  it("never shows an entity only another agent's private note names", async () => {
    expect(await graphAs(threads.a, 'Falcon')).toContain('"Falcon"');
    expect(await graphAs(threads.b, 'Falcon')).toContain('Nothing named');
    expect(await graphAs(threads.routine, 'Falcon')).toContain('Nothing named');
    expect(await graphAs(threads.ava, 'Falcon')).toContain('"Falcon"');
  });

  it("shows a shared entity without the links that come from another agent's private note", async () => {
    const forA = await graphAs(threads.a, 'Ada');
    expect(forA).toContain('"Standup');
    expect(forA).not.toContain('Heron');
    const forB = await graphAs(threads.b, 'Ada');
    expect(forB).toContain('Heron');
    expect(await graphAs(threads.ava, 'Ada')).toContain('Heron');
  });

  it('a private source node itself is hidden from other agents', async () => {
    expect(await graphAs(threads.a, 'Heron budget')).toContain('Nothing named');
    expect(await graphAs(threads.b, 'Heron budget')).toContain('"Heron budget"');
  });
});

describe('saving and sharing', () => {
  it("an agent's save is private unless it asks for the team", async () => {
    await saveKnowledgeAction(context(threads.b), {
      intent: '',
      note: 'Kestrel plan zebrafinch',
      title: '',
      team: false,
    });
    expect(await searchAs(threads.a, 'zebrafinch')).not.toContain('zebrafinch');
    expect(await searchAs(threads.b, 'zebrafinch')).toContain('zebrafinch');
    await saveKnowledgeAction(context(threads.b), {
      intent: '',
      note: 'Shared plan quokkaword',
      title: '',
      team: true,
    });
    expect(await searchAs(threads.a, 'quokkaword')).toContain('quokkaword');
    const saved = (await kbStore.items()).find(item => item.title.includes('quokkaword'))!;
    expect(saved).toMatchObject({ agentId: 'writer', scope: 'team' });
  });

  it("share_with_team moves only the agent's own private item", async () => {
    // B cannot share A's note, even by its exact title
    const refused = await shareWithTeamAction(context(threads.b), {
      intent: '',
      title: `Falcon codename ${SECRETS.aPrivate}`,
    });
    expect(refused.error).toContain('Nothing titled');
    expect(await searchAs(threads.b, SECRETS.aPrivate)).not.toContain(SECRETS.aPrivate);

    const shared = await shareWithTeamAction(context(threads.a), {
      intent: '',
      title: `Falcon codename ${SECRETS.aPrivate}`,
    });
    expect(shared.error).toBeNull();
    expect(await searchAs(threads.b, SECRETS.aPrivate)).toContain(SECRETS.aPrivate);
    expect(await graphAs(threads.b, 'Falcon')).toContain('"Falcon"');
  });

  it('the user moves items between private and team; the user’s own cannot be made private', async () => {
    expect(await kb.setScope(ids.bPrivate, 'team')).toBe(true);
    expect(await searchAs(threads.a, SECRETS.bPrivate)).toContain(SECRETS.bPrivate);
    expect(await kb.setScope(ids.bPrivate, 'private')).toBe(true);
    expect(await searchAs(threads.a, SECRETS.bPrivate)).not.toContain(SECRETS.bPrivate);
    expect(await kb.setScope(ids.unowned, 'private')).toBe(false);
  });

  it("an agent's indexed run chat is private, and a reindex keeps what the user chose", async () => {
    await threadStore.addMessage(threads.b, 'user', 'Remember the pelicanword');
    const item = (await kb.indexThread(threads.b, true))!;
    expect(item).toMatchObject({ agentId: 'writer', scope: 'private' });
    expect(await searchAs(threads.a, 'pelicanword')).not.toContain('pelicanword');
    await kb.setScope(item.id, 'team');
    await threadStore.addMessage(threads.b, 'planner', 'Noted');
    expect((await kb.indexThread(threads.b, true))!.scope).toBe('team');
  });
});

describe('pure rules', () => {
  it('reads an item scope, old items included', () => {
    expect(itemScope({ agentId: 'x' })).toBe('private');
    expect(itemScope({ agentId: 'x', scope: 'team' })).toBe('team');
    expect(itemScope({ agentId: null })).toBe('unowned');
  });

  it('Ava filtered to one agent sees only that agent’s items', () => {
    const scope = memoryScope.ava(W, 'writer');
    expect(canSee(scope, { agentId: 'writer', workspaceId: W })).toBe(true);
    expect(canSee(scope, { agentId: 'scout', scope: 'team', workspaceId: W })).toBe(false);
  });

  it('workspace summaries, which every agent reads, leave private memory out', () => {
    const items = [
      { id: '1', workspaceId: W, agentId: 'scout' },
      { id: '2', workspaceId: W, agentId: 'scout', scope: 'team' },
      { id: '3', workspaceId: W, agentId: null },
    ] as KnowledgeItem[];
    expect(itemsOf(items, W).map(item => item.id)).toEqual(['2', '3']);
  });
});
