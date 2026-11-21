import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AviCopilotDb, createPeopleStore } from '@extension/storage';
import { createPeople, onPeopleChange, peopleHooks } from '../people';
import type { People } from '../people';

const A = 'ws_alpha';
let people: People;

beforeEach(() => {
  people = createPeople(createPeopleStore(new AviCopilotDb(`people-bg-${crypto.randomUUID()}`)));
});

afterEach(() => {
  peopleHooks.linkTaskOwner = null;
  peopleHooks.moveTasks = null;
  peopleHooks.seedVocabulary = null;
});

describe('people hooks', () => {
  it("a new person's name and aliases reach the vocabulary seeds", async () => {
    const seedVocabulary = vi.fn(async () => {});
    peopleHooks.seedVocabulary = seedVocabulary;
    await people.observe({ text: 'dev.kunle', source: 'meet', workspaceId: A, meetingId: 'm1', ref: 'm1' });
    const [question] = await people.store.readyToAsk({ meetingId: 'm1' });
    await people.answer(question.id, { kind: 'new', name: 'Kunle' });
    expect(seedVocabulary).toHaveBeenCalledWith(['Kunle', 'dev.kunle'], A);
    expect((await people.store.vocabularySeeds(A)).sort()).toEqual(['Kunle', 'dev.kunle']);
  });

  it('an answer links the tasks that waited on the name; a known name links at once', async () => {
    const linkTaskOwner = vi.fn(async () => {});
    peopleHooks.linkTaskOwner = linkTaskOwner;
    await people.observe({ text: 'Chidi', source: 'spoken', workspaceId: A, taskId: 'task-1' });
    expect(linkTaskOwner).not.toHaveBeenCalled();
    const [question] = await people.store.readyToAsk();
    const { personId } = await people.answer(question.id, { kind: 'new', name: 'Chidi' });
    expect(linkTaskOwner).toHaveBeenCalledWith('task-1', personId);
    await people.observe({ text: 'chidi', source: 'task', workspaceId: A, taskId: 'task-2' });
    expect(linkTaskOwner).toHaveBeenLastCalledWith('task-2', personId);
  });

  it("merging moves the dropped person's tasks and says so", async () => {
    const moveTasks = vi.fn(async () => {});
    peopleHooks.moveTasks = moveTasks;
    const events: unknown[] = [];
    const off = onPeopleChange(event => events.push(event));
    const keep = await people.create({ name: 'Kunle', workspaceId: A });
    const drop = await people.create({ name: 'Kunle A.', workspaceId: A });
    await people.merge(keep.id, drop.id);
    off();
    expect(moveTasks).toHaveBeenCalledWith(drop.id, keep.id);
    expect(events).toEqual([{ kind: 'merged', keptId: keep.id, droppedId: drop.id }]);
  });

  it('observeAll never throws', async () => {
    const results = await people.observeAll([
      { text: '', source: 'slack', workspaceId: A },
      { text: 'Bisi', source: 'slack', workspaceId: A },
    ]);
    expect(results.map(result => result.kind)).toEqual(['skipped', 'candidate']);
  });
});
