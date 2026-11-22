/**
 * After the call (docs/pm-desk.md, Part 6): "Tasks from this call" in the meeting's chat, and its one button,
 * "Looks right". Until that click nothing is sent and no recording is shared (rule 3). On the click, and only from
 * the panel command for it:
 * - the call's recordings in Drive are shared (`shareRecordingsFor`, Part 7);
 * - Avi gets one WhatsApp message per person with that person's tasks and recording links, written to be forwarded
 *   (`sendPersonTaskList`, Part 8: owner-only, quiet hours hold it, a do-once key each); past five people, one message;
 * - the follow-ups part hears about it (`onCallTasksConfirmed`).
 *
 * "Draft a message to Ada" types the same words into that person's chat in Avi's WhatsApp Web tab and stops: he
 * presses send. Nothing here presses Enter.
 */
import { callPersonKey } from '@extension/storage';
import type { CallListRow, CallTaskSent, CallTasksState, Person, Task } from '@extension/storage';
import type { SharedResult } from '../recordings/share';
import type { CallState } from './state';

// More people than this get one message for everyone, not one each
export const MAX_SEPARATE_MESSAGES = 5;

export interface CallPerson {
  // A Person id, or the name as said in lower case; 'me' for Avi's own
  key: string;
  name: string;
  personId: string | null;
  tasks: Task[];
}

export interface ConfirmedEvent {
  meetingId: string;
  taskIds: string[];
  people: { key: string; name: string; personId: string | null; taskIds: string[] }[];
}

type ConfirmedListener = (event: ConfirmedEvent) => void | Promise<void>;
const confirmedListeners = new Set<ConfirmedListener>();
const UNFINISHED_AFTER_MS = 120_000;

/**
 * SEAM for #111 (follow-ups): runs after "Looks right" was pressed and its messages went (or were queued). A listener
 * that throws is logged and does not stop the others.
 */
export function onCallTasksConfirmed(listener: ConfirmedListener): () => void {
  confirmedListeners.add(listener);
  return () => confirmedListeners.delete(listener);
}

type RowAction = (row: CallListRow, meetingId: string) => void | Promise<void>;
const rowActions = new Map<string, RowAction>();

/**
 * SEAM for #111: what the button of a row of `kind` does. The panel sends only the meeting and the row id; the row is
 * read from the meeting's own state, so a page cannot choose another command or other arguments.
 */
export function onCallListRowAction(kind: string, action: RowAction): () => void {
  rowActions.set(kind, action);
  return () => rowActions.delete(kind);
}

/** Runs a row's button. Throws when the row or what its part registered is not there. */
export async function runCallListRowAction(state: CallState, meetingId: string, rowId: string): Promise<void> {
  const row = (await state.get(meetingId))?.rows?.find(candidate => candidate.id === rowId);
  const action = row?.action ? rowActions.get(row.kind) : undefined;
  if (!row || !action) throw new Error(`No action for row ${rowId}`);
  await action(row, meetingId);
}

/** The call's tasks still on the board and not discarded, in the order they were said. */
export async function callTasksOf(
  state: CallTasksState | undefined,
  getTask: (id: string) => Promise<Task | undefined>,
): Promise<Task[]> {
  const tasks: Task[] = [];
  const seen = new Set<string>();
  for (const entry of state?.tasks ?? []) {
    const task = await getTask(entry.taskId);
    if (!task || task.status === 'dropped' || seen.has(task.id)) continue;
    seen.add(task.id);
    tasks.push(task);
  }
  return tasks;
}

export const personKeyOf = callPersonKey;

/** The call's tasks by person: a person's name as Avi calls them when known, else the name as said. */
export function groupByPerson(tasks: Task[], people: Map<string, Pick<Person, 'id' | 'name'>>, selfName: string) {
  const groups = new Map<string, CallPerson>();
  for (const task of tasks) {
    const key = personKeyOf(task);
    const person = task.ownerId ? people.get(task.ownerId) : undefined;
    const name = person?.name ?? task.ownerName ?? selfName;
    const group = groups.get(key) ?? { key, name, personId: task.ownerId ?? null, tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** The message for one person, as Avi forwards it: the tasks, each with its recording link. */
export function personMessage(person: CallPerson, title: string): string {
  const lines = [title];
  person.tasks.forEach((task, index) => {
    lines.push(`${index + 1}. ${task.title}`);
    for (const extra of (task.detail ?? '').split('\n').filter(Boolean)) lines.push(`   ${extra}`);
    for (const link of task.links) lines.push(`   ${link.url}`);
  });
  return lines.join('\n');
}

export interface ConfirmDeps {
  state: CallState;
  tasks: { get(id: string): Promise<Task | undefined> };
  people(): Promise<Map<string, Pick<Person, 'id' | 'name'>>>;
  share(taskIds: string[]): Promise<SharedResult[]>;
  // One message to Avi himself (Part 8). `owner` shows each task's owner, for the one message for everyone
  send(input: {
    key: string;
    title: string;
    name: string;
    taskIds: string[];
    note?: string;
    links?: string[];
    owner?: boolean;
  }): Promise<CallTaskSent['whatsapp']>;
  text: {
    selfName: string;
    allTitle: string;
    // The line above the recording links
    recordingsNote: string;
  };
  now(): number;
  warn(message: string, error: unknown): void;
}

/**
 * "Looks right": what was said on the call is passed on. Once per meeting: a second press answers with what the
 * first did. Recordings are shared first, so the messages carry their links.
 */
export async function confirmCallTasks(meetingId: string, deps: ConfirmDeps): Promise<CallTasksState> {
  // A press whose background stopped before it finished (no `sent` after two minutes) can be pressed again: every
  // share and message has its own do-once key, so what already went does not go twice
  const done = (state: CallTasksState) =>
    !!state.confirmedAt && (!!state.sent || deps.now() - state.confirmedAt < UNFINISHED_AFTER_MS);
  const before = await deps.state.get(meetingId);
  if (before && done(before)) return before;
  // Taken first, in one write, so two clicks cannot both send
  let claimed = false;
  const marked = await deps.state.change(meetingId, state => {
    if (done(state)) return state;
    claimed = true;
    return { ...state, confirmedAt: deps.now(), open: null, pending: null };
  });
  if (!claimed) return marked;

  const tasks = (await callTasksOf(marked, deps.tasks.get)).filter(task => task.status === 'open');
  const taskIds = tasks.map(task => task.id);
  let shared: SharedResult[] = [];
  if (taskIds.length) {
    shared = await deps.share(taskIds).catch(error => {
      deps.warn('Could not share the recordings of a call', error);
      return [];
    });
  }
  // Read again: sharing put the links on the tasks
  const fresh = (await Promise.all(taskIds.map(id => deps.tasks.get(id)))).filter((task): task is Task => !!task);
  const groups = groupByPerson(fresh, await deps.people(), deps.text.selfName);
  const linksOf = (group: CallPerson) =>
    shared.filter(result => result.link && group.tasks.some(task => task.id === result.taskId)).map(r => r.link!);

  const sent: CallTaskSent[] = [];
  const safeSend = async (input: Parameters<ConfirmDeps['send']>[0]) => {
    try {
      return await deps.send(input);
    } catch (error) {
      deps.warn('A WhatsApp message after a call was not sent', error);
      return 'failed' as const;
    }
  };
  if (groups.length > MAX_SEPARATE_MESSAGES) {
    const links = groups.flatMap(linksOf);
    const whatsapp = await safeSend({
      key: `after-call:${meetingId}:all`,
      title: deps.text.allTitle,
      name: deps.text.allTitle,
      taskIds,
      owner: true,
      ...(links.length ? { note: deps.text.recordingsNote, links } : {}),
    });
    for (const group of groups) {
      sent.push({ personKey: group.key, name: group.name, taskIds: group.tasks.map(t => t.id), whatsapp, links: [] });
    }
  } else {
    for (const group of groups) {
      const links = linksOf(group);
      const whatsapp = await safeSend({
        key: `after-call:${meetingId}:${group.key}`,
        title: group.name,
        name: group.name,
        taskIds: group.tasks.map(task => task.id),
        ...(links.length ? { note: deps.text.recordingsNote, links } : {}),
      });
      sent.push({ personKey: group.key, name: group.name, taskIds: group.tasks.map(t => t.id), whatsapp, links });
    }
  }

  const skipped = shared.filter(result => result.skipped).map(result => result.skipped!);
  const state = await deps.state.change(meetingId, current => ({
    ...current,
    sent,
    ...(skipped.length ? { shareSkipped: [...new Set(skipped)] } : {}),
  }));

  const event: ConfirmedEvent = {
    meetingId,
    taskIds,
    people: groups.map(group => ({
      key: group.key,
      name: group.name,
      personId: group.personId,
      taskIds: group.tasks.map(task => task.id),
    })),
  };
  for (const listener of confirmedListeners) {
    try {
      await listener(event);
    } catch (error) {
      deps.warn('A listener for confirmed call tasks failed', error);
    }
  }
  return state;
}

/**
 * SEAM for #111: rows another part shows on the after-call list (a "Mark done?" suggestion). Replaces rows with the
 * same id; `[]` with `replaceKind` clears that part's rows.
 */
export async function addCallListRows(
  state: CallState,
  meetingId: string,
  rows: CallListRow[],
  options: { replaceKind?: string } = {},
): Promise<void> {
  await state.change(meetingId, current => {
    const ids = new Set(rows.map(row => row.id));
    const kept = (current.rows ?? []).filter(
      row => !ids.has(row.id) && (!options.replaceKind || row.kind !== options.replaceKind),
    );
    return { ...current, rows: [...kept, ...rows].slice(-100) };
  });
}
