import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db, taskStore } from '@extension/storage';
import type { Person } from '@extension/storage';

const addPersonSeeds = vi.fn(async () => {});
vi.mock('../../voice/vocabulary', () => ({ addPersonSeeds }));

const { ownerInputs, personSeeds, syncPeopleSeeds, wirePeopleHooks } = await import('../links');
const { people, peopleHooks } = await import('../people');
const { taskOwnerInputs } = await import('../sources');

// Made-up people and workspaces only
const A = 'ws_alpha';
const B = 'ws_beta';

afterEach(async () => {
  peopleHooks.linkTaskOwner = null;
  peopleHooks.moveTasks = null;
  peopleHooks.seedVocabulary = null;
  await Promise.all([db.people.clear(), db.peopleNames.clear(), db.tasks.clear()]);
});

const person = (over: Partial<Person>): Person =>
  ({
    id: 'per_1',
    name: 'Adaeze Okafor',
    aliases: [],
    handles: [],
    emails: [],
    phones: [],
    workspaceIds: [],
    seen: [],
    ...over,
  }) as Person;

describe('vocabulary seeds', () => {
  it("are each person's name and the names that hold in each workspace, never another workspace's", () => {
    const seeds = personSeeds([
      person({
        workspaceIds: [A, B],
        aliases: [
          { text: 'Ada', workspaceId: A, from: 'avi' },
          { text: 'Daze', workspaceId: null, from: 'avi' },
        ],
      }),
      person({ id: 'per_2', name: 'Kunle Ade' }),
    ]);
    expect(seeds).toEqual([
      { id: `per_1@${A}`, name: 'Adaeze Okafor', aliases: ['Ada', 'Daze'], workspaceId: A },
      { id: `per_1@${B}`, name: 'Adaeze Okafor', aliases: ['Daze'], workspaceId: B },
      { id: 'per_2', name: 'Kunle Ade', aliases: [], workspaceId: null },
    ]);
  });

  it('are synced from everyone in the store', async () => {
    await people.create({ name: 'Tolu Bello', workspaceId: A, alias: 'TB' });
    addPersonSeeds.mockClear();
    await syncPeopleSeeds();
    expect(addPersonSeeds).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'Tolu Bello', aliases: ['TB'], workspaceId: A }),
    ]);
  });
});

describe('task owners', () => {
  it("a known owner's task is linked to them, and a merge moves it", async () => {
    wirePeopleHooks();
    const ada = await people.create({ name: 'Ada Obi', workspaceId: A });
    const dup = await people.create({ name: 'Adaeze O.', workspaceId: A });
    const recorded = await taskStore.record({
      title: 'Write the release note',
      ownerName: 'Ada Obi',
      workspaceId: A,
      source: { kind: 'meeting', id: 'm1' },
    });
    const taskId = recorded!.task.id;
    await people.observe({ text: 'Ada Obi', source: 'task', workspaceId: A, taskId });
    expect((await taskStore.get(taskId))?.ownerId).toBe(ada.id);

    await people.merge(dup.id, ada.id);
    expect((await taskStore.get(taskId))?.ownerId).toBe(dup.id);
  });

  it("an unknown owner's task waits for the answer, then is linked", async () => {
    wirePeopleHooks();
    const recorded = await taskStore.record({
      title: 'Book the demo',
      ownerName: 'Chidi',
      workspaceId: A,
      source: { kind: 'chat', id: 't1' },
    });
    const taskId = recorded!.task.id;
    const seen = await people.observe({ text: 'Chidi', source: 'task', workspaceId: A, taskId });
    expect(seen).toMatchObject({ kind: 'candidate', asking: true });
    const { personId } = await people.answer((seen as { candidateId: string }).candidateId, {
      kind: 'new',
      name: 'Chidi Eze',
    });
    expect((await taskStore.get(taskId))?.ownerId).toBe(personId);
  });

  it("reads a chat's action owners from the graph, with their tasks", () => {
    const inputs = taskOwnerInputs({ id: 'kb1', sourceType: 'thread', workspaceId: A }, {
      entities: [
        { id: 'a1', type: 'action', label: 'Send the deck', taskId: 'tsk_9', workspaceId: A },
        { id: 'p1', type: 'person', label: 'Tolu Bello', workspaceId: A },
        { id: 'a2', type: 'action', label: 'No task', workspaceId: A },
      ],
      edges: [
        { from: 'a1', to: 'p1', kind: 'assigned_to' },
        { from: 'a2', to: 'p1', kind: 'assigned_to' },
      ],
    } as never);
    expect(inputs).toEqual([
      expect.objectContaining({ text: 'Tolu Bello', source: 'task', taskId: 'tsk_9', workspaceId: A, ref: 'kb|kb1' }),
    ]);
    // A meeting's owners come from its note instead
    expect(taskOwnerInputs({ id: 'kb2', sourceType: 'meeting', workspaceId: A }, { entities: [], edges: [] })).toEqual(
      [],
    );
  });

  it('reads owners a task tool named, once per name and task, never the owner himself', () => {
    const task = (over: Record<string, unknown>) =>
      ({
        id: 'tsk_1',
        title: 'Fix the login redirect',
        status: 'open',
        ownerId: null,
        ownerName: null,
        workspaceId: A,
        ...over,
      }) as never;
    const seen = new Set<string>();
    const board = [
      task({ ownerName: 'Ngozi' }),
      task({ id: 'tsk_2', ownerName: 'me' }),
      task({ id: 'tsk_3', ownerName: 'the team' }),
      task({ id: 'tsk_4', ownerName: 'Tolu', ownerId: 'per_2' }),
      task({ id: 'tsk_5', ownerName: 'Tolu', status: 'done' }),
    ];
    expect(ownerInputs(board, seen)).toEqual([
      expect.objectContaining({ text: 'Ngozi', source: 'task', taskId: 'tsk_1', workspaceId: A }),
    ]);
    // The same board again is no new sighting; a new owner on the same task is
    expect(ownerInputs(board, seen)).toEqual([]);
    expect(ownerInputs([task({ ownerName: 'Emeka' })], seen)).toEqual([
      expect.objectContaining({ text: 'Emeka', taskId: 'tsk_1' }),
    ]);
  });
});
