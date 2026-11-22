import { byDueThenAge, isoDay, meetingStore, personUpdateStore, stripTaskMarkers, taskStore } from '@extension/storage';
import type { MeetingRecord, Person, PersonUpdate, ResolveResult, Task, TaskListQuery } from '@extension/storage';
import { people } from '../people/people';

/**
 * A person's status (docs/pm-desk.md, Part 9.1): their latest update plus their open tasks. `person_status` answers
 * "what is Ada working on?" from it: last did, doing now, expected next and when. Plain code.
 */

export interface PersonStatus {
  person: Pick<Person, 'id' | 'name'>;
  latest: PersonUpdate | null;
  open: Task[];
  // Where the latest update came from, in words ("the call Weekly sync"), when known
  from?: string;
}

export interface StatusDeps {
  people: { resolve(text: string, options: { workspaceId: string | null }): Promise<ResolveResult> };
  updates: { forPerson(personId: string, limit?: number): Promise<PersonUpdate[]> };
  tasks: { list(query: TaskListQuery): Promise<Task[]> };
  meeting: (id: string) => Promise<Pick<MeetingRecord, 'title' | 'note'> | undefined>;
}

const defaultDeps: StatusDeps = {
  people,
  updates: personUpdateStore,
  tasks: taskStore,
  meeting: id => meetingStore.get(id),
};

/** A person's latest update and open tasks. */
export async function statusOf(
  person: Pick<Person, 'id' | 'name'>,
  deps: StatusDeps = defaultDeps,
): Promise<PersonStatus> {
  const [latest] = await deps.updates.forPerson(person.id, 1);
  const open = (await deps.tasks.list({ status: 'open', ownerId: person.id })).sort(byDueThenAge);
  let from: string | undefined;
  if (latest?.source.kind === 'meeting' && latest.source.id) {
    const meeting = await deps.meeting(latest.source.id).catch(() => undefined);
    const title = meeting?.note?.title || meeting?.title;
    if (title) from = `the call "${oneLine(title, 80)}"`;
  } else if (latest?.source.kind === 'whatsapp') from = 'what you reported on WhatsApp';
  else if (latest) from = 'what you noted';
  return { person, latest: latest ?? null, open, ...(from ? { from } : {}) };
}

const oneLine = (text: string, max = 200) => stripTaskMarkers(text.replace(/\s+/g, ' ').trim()).slice(0, max);

/** "Thu 27 Nov" for an ISO day. */
export function dayLabel(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day, 12).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/**
 * The status as the model reads it: what they said and their open tasks. Everything in it came from a call or a
 * message, so the caller marks it as data (`wrap`).
 */
export function statusText(status: PersonStatus, now: number, wrap: (text: string) => string = text => text): string {
  const name = oneLine(status.person.name, 60);
  const lines: string[] = [];
  const update = status.latest;
  if (update) {
    lines.push(
      `Latest update from ${name}: ${dayLabel(isoDay(update.at))}${status.from ? `, from ${status.from}` : ''}.`,
    );
    const list = (label: string, items: string[]) =>
      items.length && lines.push(`${label}: ${items.map(item => oneLine(item)).join('; ')}`);
    list('Did', update.did);
    list('Doing now', update.doing);
    list('Next', update.next);
    if (update.by)
      lines.push(`Expected by: ${dayLabel(update.by)}${update.byText ? ` ("${oneLine(update.byText, 60)}")` : ''}`);
    else if (update.byText) lines.push(`Expected: "${oneLine(update.byText, 60)}" (no date worked out)`);
    list('Blocked by', update.blockers);
  } else {
    lines.push(`No update from ${name} yet.`);
  }
  if (status.open.length) {
    lines.push(`Open tasks (${status.open.length}):`);
    for (const task of status.open.slice(0, 10)) {
      const due = task.due ? ` (due ${dayLabel(task.due)}${task.due < isoDay(now) ? ', overdue' : ''})` : '';
      lines.push(`- ${oneLine(task.title, 160)}${due}`);
    }
    if (status.open.length > 10) lines.push(`- …and ${status.open.length - 10} more on the Tasks page`);
  } else {
    lines.push('No open tasks.');
  }
  return wrap(lines.join('\n'));
}

/**
 * `person_status`: who the name is, then their status. Several people of that name, or none, are said, never
 * guessed. `workspaceId` is the chat's (an agent) or undefined (voice looks everywhere).
 */
export async function personStatusAnswer(
  name: string,
  options: { workspaceId?: string | null; now: number; wrap?: (text: string) => string },
  deps: StatusDeps = defaultDeps,
): Promise<string> {
  const words = name.trim();
  if (!words) return 'Say whose status: their name.';
  let resolved = await deps.people.resolve(words, { workspaceId: options.workspaceId ?? null });
  // Voice looks across workspaces: a name not found in "none" is tried everywhere the people list has it
  if (!resolved && options.workspaceId === undefined) resolved = await peopleCalled(words);
  if (!resolved) return `No one called "${oneLine(words, 60)}" is in People yet.`;
  if ('candidates' in resolved) {
    const names = resolved.candidates.map(person => `${oneLine(person.name, 60)} [${person.id}]`).join(', ');
    return `Several people are called "${oneLine(words, 60)}": ${names}. Ask the user which one, then call again with the full name.`;
  }
  return statusText(await statusOf(resolved.person, deps), options.now, options.wrap);
}

/** Everyone called this, in any workspace: one is the person, several are asked about. */
async function peopleCalled(words: string): Promise<ResolveResult> {
  const everyone = await people.list().catch(() => [] as Person[]);
  const want = words.toLowerCase();
  const found = everyone.filter(
    person =>
      person.name.toLowerCase() === want ||
      person.name.toLowerCase().split(' ')[0] === want ||
      person.aliases.some(alias => alias.text.toLowerCase() === want),
  );
  if (found.length === 1) return { person: found[0], via: 'name' } as ResolveResult;
  return found.length ? { candidates: found } : null;
}
