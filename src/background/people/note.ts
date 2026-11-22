import { cleanEmail, cleanName } from '@extension/storage';
import { people } from './people';
import type { People } from './people';

/**
 * `person_note`: what the owner says about a person, saved as it is (docs/pm-desk.md 5.2, source 'avi'). Plain
 * code: the name is resolved in the workspace; a known person gets the note, the other name or the address; an
 * unknown one is created, since the owner's own word is what makes a person.
 */

export interface PersonNoteInput {
  name: string;
  // One line about them: their role, what they do
  note?: string;
  // Another name they go by in this workspace
  alias?: string;
  email?: string;
  workspaceId: string | null;
  // Every name and address must be in the owner's own words: what they typed in the chat, or said to Ava
  userWords: string;
}

const tokens = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Whole words, in order: "Ada" is not in "Canada", "ill" is not in "I will". */
export function saidName(words: string, value: string): boolean {
  const have = tokens(words);
  const want = tokens(value);
  if (want.length === 0) return true;
  for (let at = 0; at + want.length <= have.length; at++) {
    if (want.every((word, index) => have[at + index] === word)) return true;
  }
  return false;
}

/** Every part of an address, typed ("ada@example.test") or spoken ("ada at example dot test"). */
export function saidEmail(words: string, email: string): boolean {
  const have = new Set(tokens(words));
  return tokens(email).every(word => have.has(word));
}

export async function personNote(input: PersonNoteInput, api: People = people): Promise<string> {
  const name = cleanName(input.name);
  if (!name) return 'Say who the note is about.';
  const alias = cleanName(input.alias);
  const email = input.email ? cleanEmail(input.email) : null;
  if (input.email?.trim() && !email) return `"${input.email.trim()}" is not an email address.`;
  const words = input.userWords;
  const missing = [
    ...[name, alias].filter(value => value && !saidName(words, value)),
    ...(email && !saidEmail(words, email) ? [email] : []),
  ];
  if (missing.length) {
    return `I only note people from the user's own words, and they did not say "${missing[0]}". Ask them to say it.`;
  }
  const note = (input.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const found = await api.resolve(name, { workspaceId: input.workspaceId });
  if (found && 'candidates' in found) {
    return `Several people go by ${name}: ${found.candidates.map(person => person.name).join(', ')}. Ask which one, or change it on the People page.`;
  }
  if (!found) {
    const person = await api.create({
      name,
      workspaceId: input.workspaceId,
      about: note,
      email: email ?? undefined,
      alias: alias || undefined,
    });
    return `Added ${person.name} to People${note ? `: ${note}` : ''}.`;
  }
  let person = found.person;
  if (alias) person = await api.addAlias(person.id, alias, input.workspaceId);
  if (note || email) {
    person = await api.edit(person.id, {
      ...(note ? { about: note } : {}),
      ...(email ? { emails: [...new Set([...person.emails, email])] } : {}),
    });
  }
  const parts = [note && `"${note}"`, alias && `also called ${alias}`, email && email].filter(Boolean);
  return parts.length ? `Noted for ${person.name}: ${parts.join(', ')}.` : `${person.name} is already in People.`;
}
