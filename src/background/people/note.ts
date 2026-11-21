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
  // When given (a typed chat), every name and address must be in the owner's own words there
  userWords?: string;
}

const said = (words: string, value: string) => words.toLowerCase().includes(value.trim().toLowerCase());

export async function personNote(input: PersonNoteInput, api: People = people): Promise<string> {
  const name = cleanName(input.name);
  if (!name) return 'Say who the note is about.';
  const alias = cleanName(input.alias);
  const email = input.email ? cleanEmail(input.email) : null;
  if (input.email?.trim() && !email) return `"${input.email.trim()}" is not an email address.`;
  if (input.userWords !== undefined) {
    const missing = [name, alias, email ?? ''].filter(value => value && !said(input.userWords!, value));
    if (missing.length) {
      return `I only note people from the user's own words, and they did not write "${missing[0]}". Ask them to say it.`;
    }
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
