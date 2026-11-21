import { peopleStore, taskStore } from '@extension/storage';
import type { ObserveInput, Person, Task } from '@extension/storage';
import { createLogger } from '../log';
import { isNobody, isSelfName } from './owner';
import { addPersonSeeds } from '../voice/vocabulary';
import { people, peopleHooks } from './people';

/**
 * Where people meet the other PM-desk parts (docs/pm-desk.md Part 5): a task's owner is the person their name
 * resolves to (the task board's `setOwner`), a merge moves the tasks, and every person's name and other names are
 * vocabulary seeds, so the recogniser hears them right.
 */

const logger = createLogger('People');

type SeedPerson = Parameters<typeof addPersonSeeds>[0][number];

/**
 * One seed entry per person and workspace: their name, and the other names that hold there. A person in no
 * workspace counts everywhere. An alias saved for one workspace is never a seed in another.
 */
export function personSeeds(people: Person[]): SeedPerson[] {
  const entries: SeedPerson[] = [];
  for (const person of people) {
    const workspaces: (string | null)[] = person.workspaceIds.length ? person.workspaceIds : [null];
    for (const workspaceId of workspaces) {
      const aliases = person.aliases
        .filter(alias => alias.workspaceId === null || workspaceId === null || alias.workspaceId === workspaceId)
        .map(alias => alias.text);
      entries.push({
        // The seed key is per entry: the same person has one entry per workspace
        id: workspaceId ? `${person.id}@${workspaceId}` : person.id,
        name: person.name,
        aliases: [...new Set(aliases)],
        workspaceId,
      });
    }
  }
  return entries;
}

/** Brings the vocabulary's person seeds in step with everyone in the store. Never throws. */
export async function syncPeopleSeeds(): Promise<void> {
  try {
    await addPersonSeeds(personSeeds(await peopleStore.list()));
  } catch (error) {
    logger.warning('Could not seed the vocabulary with people', error);
  }
}

let pending: ReturnType<typeof setTimeout> | null = null;

/** A sync soon: many changes in a row (a card answered name by name) make one. */
export function syncPeopleSeedsSoon(delayMs = 1500): void {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    void syncPeopleSeeds();
  }, delayMs);
}

/** Sets the hooks people.ts calls: task owners, merges, and vocabulary seeds. */
export function wirePeopleHooks(): void {
  peopleHooks.linkTaskOwner = async (taskId, personId) => {
    await taskStore.setOwner(taskId, personId);
  };
  peopleHooks.moveTasks = async (fromPersonId, toPersonId) => {
    await taskStore.replaceOwner(fromPersonId, toPersonId);
  };
  // The seeds are synced as a whole: a rename or a removed alias drops the old seed too
  peopleHooks.seedVocabulary = async () => syncPeopleSeedsSoon();
}

/** A removed person owns no tasks any more; the name as said stays on each. */
export async function unlinkTasks(personId: string): Promise<void> {
  await taskStore.replaceOwner(personId, null);
}

/** The key of one owner name on one task: a repeat change of anything else on the task is no new sighting. */
const ownerKey = (task: Task) => `${task.id}|${(task.ownerName ?? '').trim().toLowerCase()}`;

/**
 * Owners a task tool or an edit named ("give the login task to Ada"): open tasks with an owner name and no person
 * yet. Meeting and graph owners come in on their own paths too; the same name on the same task counts once.
 */
export function ownerInputs(tasks: Task[], seen: Set<string>): ObserveInput[] {
  const inputs: ObserveInput[] = [];
  for (const task of tasks) {
    const name = task.ownerName?.trim();
    if (!name || task.ownerId || task.status !== 'open' || isSelfName(name) || isNobody(name)) continue;
    const key = ownerKey(task);
    if (seen.has(key)) continue;
    seen.add(key);
    inputs.push({
      text: name,
      source: 'task',
      workspaceId: task.workspaceId,
      taskId: task.id,
      ref: `task|${key}`,
      context: `owns the task ${JSON.stringify(task.title.slice(0, 80))}`,
    });
  }
  return inputs.slice(0, 30);
}

/** Watches the board for owner names to link. Returns a stop. */
export function watchTaskOwners(): () => void {
  const seen = new Set<string>();
  return taskStore.onChange(tasks => {
    const inputs = ownerInputs(tasks, seen);
    if (inputs.length)
      void people.observeAll(inputs).catch(error => logger.warning('Could not learn task owners', error));
  });
}
