import { dueFromText, firstNameOf, nameKey, personUpdateIdOf, personUpdateStore, taskStore } from '@extension/storage';
import type {
  MeetingNote,
  MeetingRecord,
  NoteUpdate,
  ObserveInput,
  ObserveResult,
  PersonUpdate,
  ResolveResult,
  Task,
  TaskListQuery,
  TranscriptSegment,
} from '@extension/storage';
import { isGenericSpeaker } from '../meetings/speakers';
import { isNobody } from '../people/owner';
import { people } from '../people/people';
import { hasWords } from './note';
import { matchDone } from './match';
import { isOwnerName, ownerNames } from './owner';
import type { OwnerNames } from './owner';

/**
 * A call's updates, stored per person (docs/pm-desk.md, Part 9.1). The note's model read who said what; from there
 * it is code: the name goes through people.resolve (and people.observe when it is not known yet), the date words are
 * worked out from the call's day, and a "did" that matches an open task of theirs becomes a "Mark done?" offer.
 * Nothing here closes a task.
 */

export interface UpdateDeps {
  people: {
    resolve(text: string, options: { workspaceId: string | null }): Promise<ResolveResult>;
    observe(input: ObserveInput): Promise<ObserveResult>;
  };
  tasks: { list(query: TaskListQuery): Promise<Task[]> };
  updates: { save(update: PersonUpdate): Promise<PersonUpdate> };
  owner: () => Promise<OwnerNames>;
}

const defaultDeps: UpdateDeps = {
  people,
  tasks: taskStore,
  updates: personUpdateStore,
  owner: ownerNames,
};

/**
 * The names that spoke on the call, when the transcript knows them (captions name every line). Null when any line
 * has no real name (audio gives "Speaker 1"): then who spoke cannot be told, and the model's reading stands.
 */
export function speakerKeys(segments: Pick<TranscriptSegment, 'speaker'>[]): Set<string> | null {
  if (!segments.length || segments.some(segment => isGenericSpeaker(segment.speaker))) return null;
  return new Set(segments.flatMap(segment => [nameKey(segment.speaker), firstNameOf(nameKey(segment.speaker))]));
}

/**
 * The note's updates that count: someone said something, it is not Avi himself (his own words are commands and
 * tasks, not a status to chase), not "the team", and, when the transcript names its speakers, someone who spoke.
 * One entry per name.
 */
export function updatesToKeep(
  note: Pick<MeetingNote, 'personUpdates'>,
  segments: Pick<TranscriptSegment, 'speaker'>[],
  owner: OwnerNames,
): NoteUpdate[] {
  const spoke = speakerKeys(segments);
  const kept = new Map<string, NoteUpdate>();
  for (const update of note.personUpdates ?? []) {
    const name = update.name?.replace(/\s+/g, ' ').trim() ?? '';
    const key = nameKey(name);
    if (!key || !hasWords(update) || isNobody(name) || isOwnerName(name, owner)) continue;
    if (spoke && !spoke.has(key) && !spoke.has(firstNameOf(key))) continue;
    const before = kept.get(key);
    kept.set(
      key,
      before
        ? {
            ...before,
            did: [...before.did, ...update.did],
            doing: [...before.doing, ...update.doing],
            next: [...before.next, ...update.next],
            blockers: [...before.blockers, ...update.blockers],
            by: update.by ?? before.by,
          }
        : { ...update, name },
    );
  }
  return [...kept.values()];
}

/** Who a name is: the one person it resolves to, or null (unknown, or several: People asks, never picks). */
async function personFor(
  deps: UpdateDeps,
  name: string,
  meeting: Pick<MeetingRecord, 'id' | 'workspaceId'>,
): Promise<string | null> {
  const workspaceId = meeting.workspaceId ?? null;
  const resolved = await deps.people.resolve(name, { workspaceId }).catch(() => null);
  if (resolved && 'person' in resolved) return resolved.person.id;
  // Not known yet: People asks who it is on the call's card, under the call's own sighting key
  const seen = await deps.people
    .observe({
      text: name,
      source: 'meet',
      workspaceId,
      meetingId: meeting.id,
      ref: `meet:${meeting.id}`,
      context: 'gave an update on the call',
    })
    .catch(() => null);
  return seen?.kind === 'person' ? seen.personId : null;
}

/** A person's open tasks: by their id, or by the name as said when the task has no person yet. */
export async function openTasksOf(
  deps: Pick<UpdateDeps, 'tasks'>,
  personId: string | null,
  name: string,
): Promise<Task[]> {
  if (personId) return deps.tasks.list({ status: 'open', ownerId: personId });
  const key = nameKey(name);
  return (await deps.tasks.list({ status: 'open' })).filter(task => !task.ownerId && nameKey(task.ownerName) === key);
}

/** Stores a finished call's updates, one per person. Safe to run twice: the same call and name keep one record. */
export async function recordMeetingUpdates(
  meeting: Pick<MeetingRecord, 'id' | 'startedAt' | 'endedAt' | 'workspaceId'>,
  note: Pick<MeetingNote, 'personUpdates'>,
  segments: Pick<TranscriptSegment, 'speaker'>[],
  deps: UpdateDeps = defaultDeps,
): Promise<PersonUpdate[]> {
  const owner = await deps.owner();
  const saved: PersonUpdate[] = [];
  for (const update of updatesToKeep(note, segments, owner)) {
    const personId = await personFor(deps, update.name, meeting);
    // A task given on this same call is not one they can have finished before it
    const tasks = (await openTasksOf(deps, personId, update.name).catch(() => [] as Task[])).filter(
      task => !(task.source.kind === 'meeting' && task.source.id === meeting.id),
    );
    const byText = update.by?.trim() || undefined;
    const by = byText ? dueFromText(byText, meeting.startedAt) : undefined;
    saved.push(
      await deps.updates.save({
        id: personUpdateIdOf('meeting', meeting.id, nameKey(update.name)),
        personId,
        name: update.name,
        workspaceId: meeting.workspaceId ?? null,
        did: update.did,
        doing: update.doing,
        next: update.next,
        ...(by ? { by } : {}),
        ...(byText ? { byText } : {}),
        blockers: update.blockers,
        source: { kind: 'meeting', id: meeting.id },
        at: meeting.startedAt,
        offers: matchDone(update.did, tasks),
      }),
    );
  }
  return saved;
}
