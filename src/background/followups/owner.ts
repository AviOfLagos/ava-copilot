import { accountProfileStore, nameKey } from '@extension/storage';
import type { Person, Task } from '@extension/storage';
import { isNobody, isSelfName, ownerEmails } from '../people/owner';

/**
 * Who Avi is, for the follow-ups (docs/pm-desk.md, Part 9.2): a task is chased only when its owner is someone
 * other than him. He is the name he set for his profile (and its first word), and "me", "I", "you" and the like.
 * A task with no owner is nobody's to chase.
 */

export interface OwnerNames {
  // Name keys (people's nameKey) that mean Avi
  keys: Set<string>;
  // His own addresses (each workspace's Google account), lowercase
  emails?: Set<string>;
}

/** Avi's names from his profile, and his addresses. */
export async function ownerNames(): Promise<OwnerNames> {
  const display = await accountProfileStore.getDisplayName().catch(() => '');
  const emails = await ownerEmails().catch(() => new Set<string>());
  return { ...ownerNamesOf(display), emails };
}

export function ownerNamesOf(display: string): OwnerNames {
  const key = nameKey(display);
  const keys = new Set<string>();
  if (key) {
    keys.add(key);
    keys.add(key.split(' ')[0]);
  }
  return { keys };
}

/**
 * Whether Ava can tell Avi's tasks from other people's: only once his profile has a name. Until then nobody is
 * chased, since "Avi" on a task could be him.
 */
export const ownerKnown = (owner: OwnerNames) => owner.keys.size > 0;

// "mine" and "self" too, which a note may write for the owner
const MORE_SELF = /^(mine|self|my self)$/i;

/** Whether a name, as said or written, is Avi himself: "me", "Me.", "(You)", "You (me)", his name, "Avi E.". */
export function isOwnerName(name: string | null | undefined, owner: OwnerNames): boolean {
  const text = (name ?? '').trim();
  if (!text) return false;
  if (isSelfName(text) || MORE_SELF.test(text)) return true;
  // Every word is a way of saying "me": "Me.", "(You)", "You (me)"
  const words = text
    .split(/[\s()[\]{}.,!?;:"'“”‘’`/|-]+/)
    .map(word => word.trim())
    .filter(Boolean);
  if (words.length > 0 && words.every(word => isSelfName(word) || MORE_SELF.test(word))) return true;
  const key = nameKey(text);
  if (!key) return false;
  if (owner.keys.has(key)) return true;
  // His first name and initials: "Avi E.", "Avi E"
  const [first, ...rest] = key.split(' ');
  return rest.length > 0 && owner.keys.has(first) && rest.every(part => part.replace(/\./g, '').length <= 1);
}

/** Whether a person record is Avi: any of their names is one of his, or they have one of his addresses. */
export function isOwnerPerson(
  person: (Pick<Person, 'name' | 'aliases'> & Partial<Pick<Person, 'emails'>>) | undefined,
  owner: OwnerNames,
): boolean {
  if (!person) return false;
  if (person.emails?.some(email => owner.emails?.has(email.trim().toLowerCase()))) return true;
  return [person.name, ...person.aliases.map(alias => alias.text)].some(name => isOwnerName(name, owner));
}

/**
 * Whether a task belongs to someone other than Avi: it has an owner, the owner is not him by name, and the person
 * it is linked to is not him either. A name that means nobody ("Unassigned", "team") is no owner.
 */
export function ownedByOther(
  task: Pick<Task, 'ownerId' | 'ownerName'>,
  owner: OwnerNames,
  peopleById: ReadonlyMap<string, Pick<Person, 'name' | 'aliases'> & Partial<Pick<Person, 'emails'>>>,
): boolean {
  if (!ownerKnown(owner)) return false;
  const name = task.ownerName?.trim() ?? '';
  if (name && (isOwnerName(name, owner) || isNobody(name))) return false;
  const person = task.ownerId ? peopleById.get(task.ownerId) : undefined;
  if (person && isOwnerPerson(person, owner)) return false;
  // A person record that is gone leaves only the name; with neither, there is nobody to chase
  if (!person && (!name || !nameKey(name))) return false;
  return true;
}
