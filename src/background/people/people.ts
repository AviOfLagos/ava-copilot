import { peopleStore } from '@extension/storage';
import type { CandidateAnswer, ObserveInput, ObserveResult, PeopleStore, Person } from '@extension/storage';
import { createLogger } from '../log';

/**
 * The background's one way to people (docs/pm-desk.md, Part 5): every place that meets a name calls
 * `people.observe`, every place that needs to know who a name means calls `people.resolve`. Plain code; no
 * model, no network. What is learned flows back out through the hooks below, which other parts set:
 *
 * - `linkTaskOwner(taskId, personId)`: the task board (Part 2) sets it to its `tasks.setOwner`. Called when a
 *   name a task waited on is answered, and for every task of a merged-away person.
 * - `moveTasks(fromPersonId, toPersonId)`: the task board moves a merged person's tasks.
 * - `seedVocabulary(words, workspaceId)`: the vocabulary (Part 4) adds a person's name and aliases as seeds.
 */

const logger = createLogger('People');

export interface PeopleHooks {
  linkTaskOwner: ((taskId: string, personId: string) => Promise<void>) | null;
  moveTasks: ((fromPersonId: string, toPersonId: string) => Promise<void>) | null;
  // VOCABULARY HOOK (#106): set by the vocabulary part once it lands; until then a learned name seeds nothing
  seedVocabulary: ((words: string[], workspaceId: string | null) => Promise<void>) | null;
}

export const peopleHooks: PeopleHooks = { linkTaskOwner: null, moveTasks: null, seedVocabulary: null };

type Listener = (event: PeopleEvent) => void;
export type PeopleEvent =
  | { kind: 'settled'; candidateId: string; personId: string | null }
  | { kind: 'merged'; keptId: string; droppedId: string }
  | { kind: 'removed'; personId: string };
const listeners = new Set<Listener>();

/** Told when a name is settled, two people merge, or one is removed (the graph re-points its nodes). */
export function onPeopleChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event: PeopleEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      logger.warning('A people listener failed', error);
    }
  }
}

async function seed(person: Person | undefined, workspaceId: string | null): Promise<void> {
  if (!person || !peopleHooks.seedVocabulary) return;
  const words = [
    person.name,
    ...person.aliases.filter(a => a.workspaceId === null || a.workspaceId === workspaceId).map(a => a.text),
  ];
  await peopleHooks
    .seedVocabulary([...new Set(words)], workspaceId)
    .catch(error => logger.warning('Could not seed the vocabulary', error));
}

export function createPeople(store: PeopleStore = peopleStore) {
  const api = {
    store,
    resolve: store.resolve,
    list: store.list,
    get: store.get,

    /** Records that a name was seen; links the task when it names a known person. */
    async observe(input: ObserveInput): Promise<ObserveResult> {
      const result = await store.observe(input);
      if (result.kind === 'person' && peopleHooks.linkTaskOwner) {
        const taskIds = [...new Set([...(input.taskId ? [input.taskId] : []), ...(result.taskIds ?? [])])];
        for (const taskId of taskIds) {
          await peopleHooks
            .linkTaskOwner(taskId, result.personId)
            .catch(error => logger.warning('Could not link a task to its owner', error));
        }
      }
      return result;
    },

    /** Observes many names; one failing never stops the rest, and nothing here throws. */
    async observeAll(inputs: ObserveInput[]): Promise<ObserveResult[]> {
      const results: ObserveResult[] = [];
      for (const input of inputs) {
        results.push(await api.observe(input).catch(() => ({ kind: 'skipped' }) as const));
      }
      return results;
    },

    /** The owner's answer to a "Who's who" question: saved, its waiting tasks linked, its name seeded. */
    async answer(candidateId: string, answer: CandidateAnswer) {
      const candidate = await store.candidate(candidateId);
      const result = await store.answer(candidateId, answer);
      if (result.personId) {
        for (const taskId of result.taskIds) {
          await peopleHooks
            .linkTaskOwner?.(taskId, result.personId)
            .catch(error => logger.warning('Could not link a task to its owner', error));
        }
        await seed(await store.get(result.personId), candidate?.workspaceId ?? null);
      }
      emit({ kind: 'settled', candidateId, personId: result.personId });
      return result;
    },

    /**
     * "Yes, that is the same someone as that other name on the card": the other name is settled first (as a new
     * person named as it was seen, unless it already was), then this one as the same person.
     */
    async answerLike(candidateId: string, otherCandidateId: string) {
      const other = await store.candidate(otherCandidateId);
      if (!other) throw new Error('That question is no longer open.');
      let personId = other.status === 'settled' ? other.personId : null;
      if (!personId) personId = (await api.answer(otherCandidateId, { kind: 'new', name: other.text })).personId;
      if (!personId) throw new Error('That name was marked as not a person.');
      return api.answer(candidateId, { kind: 'same', personId });
    },

    async create(fields: Parameters<PeopleStore['create']>[0]) {
      const person = await store.create(fields);
      await seed(person, fields.workspaceId);
      return person;
    },

    async addAlias(personId: string, text: string, workspaceId: string | null) {
      const person = await store.addAlias(personId, text, workspaceId);
      await seed(person, workspaceId);
      return person;
    },

    edit: store.edit,

    /** Merges two people; their tasks move with them. */
    async merge(keepId: string, dropId: string) {
      const kept = await store.merge(keepId, dropId);
      await peopleHooks.moveTasks?.(dropId, keepId).catch(error => logger.warning('Could not move tasks', error));
      emit({ kind: 'merged', keptId: keepId, droppedId: dropId });
      await seed(kept, null);
      return kept;
    },

    async remove(personId: string) {
      await store.remove(personId);
      emit({ kind: 'removed', personId });
    },
  };
  return api;
}

export type People = ReturnType<typeof createPeople>;

/** The one instance the background uses. */
export const people = createPeople();
