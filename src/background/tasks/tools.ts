import { byDueThenAge, dueFromText, isTaskId, normaliseTitle, titleWords } from '@extension/storage';
import type { Task, TaskSourceKind, TaskStatus, TaskStore, Workspace } from '@extension/storage';

// The task tools (docs/pm-desk.md, Part 2.6): task_add, task_done, task_reopen, task_list, task_assign, task_move.
// One implementation for the browser agent and for voice, all plain code. Finding a task from the user's words is
// code too: when more than one task fits, the answer lists them and the model asks the user which.

/** Where a tool is called from, and who acts. */
export interface ToolScope {
  // The chat's workspace (null: none); undefined for voice, which looks across every workspace
  workspaceId?: string | null;
  // Who closes, moves or assigns: Avi's own voice, or Ava acting in a chat
  by: 'avi' | 'ava';
  source: { kind: TaskSourceKind; id?: string };
  // Marks lists of task words as data for the model (wrapUntrustedContent): they come from meetings, chats and pages
  wrap?: (text: string) => string;
}

const wrapped = (scope: ToolScope, lines: string[]) => (scope.wrap ?? (text => text))(lines.join('\n'));
// One task's words in a confirmation: quoted, on one line
const quoted = (task: Pick<Task, 'title'> | null | undefined) => JSON.stringify(task?.title ?? '');

// Words that name the kind of thing, not which one ("the login task")
const FILLER = new Set(['task', 'tasks', 'todo', 'item', 'one', 'thing', 'that', 'this', 'my', 'it']);

const queryWords = (text: string) => [...titleWords(text)].filter(word => !FILLER.has(word));

// Two words of 4+ letters fit when they share all but the last letter of the shorter one ("price", "pricing")
const shared = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};
const fits = (word: string, words: Set<string>) =>
  words.has(word) ||
  [...words].some(
    other => other.length >= 4 && word.length >= 4 && shared(word, other) >= Math.min(word.length, other.length) - 1,
  );

/**
 * The tasks the user's words name: the one whose title is exactly the words, or else every task whose title (and
 * owner) holds all of the words. Nothing when the words name nothing in particular.
 */
export function findTasks(tasks: Task[], words: string): Task[] {
  const wanted = queryWords(words);
  if (wanted.length === 0) return [];
  const exact = tasks.filter(task => normaliseTitle(task.title) === normaliseTitle(words));
  if (exact.length === 1) return exact;
  return tasks.filter(task => {
    const have = titleWords(`${task.title} ${task.ownerName ?? ''}`);
    return wanted.every(word => fits(word, have));
  });
}

/** One task as a line the model reads: words, owner, due, state, and the id to call back with. */
export function taskListLine(task: Task, workspaces: Pick<Workspace, 'id' | 'name'>[] = []): string {
  const where = workspaces.find(workspace => workspace.id === task.workspaceId)?.name ?? 'No workspace';
  const details = [
    task.ownerName ? `owner ${task.ownerName}` : 'no owner',
    task.due ? `due ${task.due}` : '',
    task.status === 'open' ? '' : task.status,
    where,
  ]
    .filter(Boolean)
    .join(', ');
  return `- ${task.title} (${details}) [${task.id}]`;
}

type Found = { task: Task } | { answer: string };

/** The one task a reference names, or what to tell the model instead (none, or several to ask about). */
async function resolve(
  store: TaskStore,
  scope: ToolScope,
  ref: string,
  statuses: TaskStatus[],
  workspaces: Pick<Workspace, 'id' | 'name'>[],
): Promise<Found> {
  const words = ref.trim();
  if (!words) return { answer: 'Say which task: its words or its id.' };
  if (isTaskId(words)) {
    const task = await store.get(words);
    return task ? { task } : { answer: `No task has the id ${words}.` };
  }
  const all = await store.list({ status: statuses });
  // In a chat, its own workspace first; across all of them when nothing there fits
  const own = scope.workspaceId === undefined ? all : all.filter(task => task.workspaceId === scope.workspaceId);
  let matches = findTasks(own, words);
  if (matches.length === 0 && own !== all) matches = findTasks(all, words);
  if (matches.length === 1) return { task: matches[0] };
  if (matches.length === 0) {
    return { answer: `No ${statuses.join(' or ')} task matches those words. task_list shows what is there.` };
  }
  return {
    answer: [
      `${matches.length} tasks match those words. Ask the user which one, then call again with its id:`,
      wrapped(
        scope,
        matches
          .sort(byDueThenAge)
          .slice(0, 8)
          .map(task => taskListLine(task, workspaces)),
      ),
    ].join('\n'),
  };
}

export async function taskAdd(
  store: TaskStore,
  scope: ToolScope,
  input: { title: string; owner?: string; due?: string; workspaceId?: string | null },
  now = Date.now(),
): Promise<string> {
  const recorded = await store.record({
    title: input.title,
    ownerName: input.owner || null,
    dueText: input.due || null,
    due: dueFromText(input.due, now),
    workspaceId: input.workspaceId !== undefined ? input.workspaceId : (scope.workspaceId ?? null),
    // Avi saying where it goes is his choice; Ava placing it in the chat's workspace is hers
    workspaceSetBy: scope.by,
    source: scope.source,
    at: now,
  });
  if (!recorded) return 'A task needs a few words on what is to be done.';
  const { task, added } = recorded;
  return added
    ? `Added ${quoted(task)} [${task.id}].`
    : `That is already on the board, so nothing new was added: ${quoted(task)} [${task.id}].`;
}

export async function taskSetStatus(
  store: TaskStore,
  scope: ToolScope,
  input: { task: string },
  status: 'done' | 'open',
  workspaces: Pick<Workspace, 'id' | 'name'>[] = [],
): Promise<string> {
  const found = await resolve(store, scope, input.task, status === 'done' ? ['open'] : ['done', 'dropped'], workspaces);
  if ('answer' in found) return found.answer;
  const task = await store.setStatus(found.task.id, status, scope.by);
  return status === 'done' ? `Marked done: ${quoted(task)}.` : `Reopened: ${quoted(task)}.`;
}

export async function taskList(
  store: TaskStore,
  scope: ToolScope,
  input: { owner?: string; status?: TaskStatus | 'all'; workspaceId?: string | null },
  workspaces: Pick<Workspace, 'id' | 'name'>[] = [],
): Promise<string> {
  const status = input.status && input.status !== 'all' ? input.status : undefined;
  const workspaceId = input.workspaceId !== undefined ? input.workspaceId : scope.workspaceId;
  let tasks = await store.list({ status: input.status === 'all' ? undefined : (status ?? 'open'), workspaceId });
  const owner = input.owner?.trim();
  if (owner) {
    const wanted = normaliseTitle(owner);
    tasks = tasks.filter(task => task.ownerName && normaliseTitle(task.ownerName).includes(wanted));
  }
  if (tasks.length === 0) return `No ${status ?? 'open'} tasks${owner ? ' for that person' : ''}.`;
  const shown = tasks.sort(byDueThenAge).slice(0, 25);
  return [
    `${tasks.length} ${status ?? 'open'} task${tasks.length === 1 ? '' : 's'}:`,
    wrapped(
      scope,
      shown.map(task => taskListLine(task, workspaces)),
    ),
    ...(tasks.length > shown.length ? [`…and ${tasks.length - shown.length} more on the Tasks page.`] : []),
  ].join('\n');
}

export async function taskAssign(
  store: TaskStore,
  scope: ToolScope,
  input: { task: string; owner: string },
  workspaces: Pick<Workspace, 'id' | 'name'>[] = [],
): Promise<string> {
  const found = await resolve(store, scope, input.task, ['open'], workspaces);
  if ('answer' in found) return found.answer;
  // The name as said; the people part links it to a person (tasks.setOwner)
  const task = await store.update(found.task.id, { ownerName: input.owner });
  return task?.ownerName
    ? `${quoted(task)} now belongs to ${JSON.stringify(task.ownerName)}.`
    : `${quoted(task)} has no owner now.`;
}

export async function taskMove(
  store: TaskStore,
  scope: ToolScope,
  input: { task: string; workspace: string },
  workspaces: Pick<Workspace, 'id' | 'name'>[],
): Promise<string> {
  const name = input.workspace.trim();
  const none = /^(none|no workspace|nowhere)$/i.test(name);
  const target = none ? null : workspaces.find(workspace => normaliseTitle(workspace.name) === normaliseTitle(name));
  if (target === undefined) {
    return `No workspace is called "${name}". The workspaces are: ${workspaces.map(workspace => workspace.name).join(', ') || 'none yet'}.`;
  }
  const found = await resolve(store, scope, input.task, ['open', 'done', 'dropped'], workspaces);
  if ('answer' in found) return found.answer;
  const moved = await store.move([found.task.id], target?.id ?? null, scope.by);
  if (moved.length === 0 && found.task.workspaceId !== (target?.id ?? null)) {
    return `${quoted(found.task)} stays where it is: the user placed it there. They can move it on the Tasks page.`;
  }
  return `${quoted(found.task)} is now in ${target?.name ?? 'No workspace'}.`;
}
