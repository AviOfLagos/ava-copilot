import { liveQuery } from 'dexie';
import { db as defaultDb } from '../threads/db';
import type { AviCopilotDb } from '../threads/db';
import { dueFromText } from './due';
import { findSameTask, ownerKey } from './match';
import { newTaskId } from './types';
import type { Task, TaskCandidate, TaskListQuery, TaskStatus, WorkspaceSetBy } from './types';

const DAY = 24 * 60 * 60 * 1000;
// "Close everything older than two weeks" on the Tasks page
export const OLD_TASK_AGE = 14 * DAY;

/** One line, at most `max` characters. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The owner's name as said, or null when the words name nobody ("Unassigned"). */
const ownerNameOf = (name: string | null | undefined): string | null =>
  ownerKey(name) === null ? null : oneLine(name ?? '', 80);

/** Oldest due first, then oldest: the order a list of open tasks is read in. */
export function byDueThenAge(a: Task, b: Task): number {
  if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
  if (a.due && !b.due) return -1;
  if (!a.due && b.due) return 1;
  return a.createdAt - b.createdAt;
}

export interface NewTask {
  title: string;
  workspaceId: string | null;
  // Defaults to 'avi': a task added by hand is placed by the user
  workspaceSetBy?: WorkspaceSetBy;
  detail?: string;
  ownerId?: string | null;
  ownerName?: string | null;
  due?: string;
  dueText?: string;
  source?: Task['source'];
  links?: Task['links'];
}

export type TaskChanges = Partial<
  Pick<Task, 'title' | 'detail' | 'ownerName' | 'due' | 'dueText' | 'links' | 'followUp' | 'externalRefs'>
>;

/**
 * The task board, over a database that defaults to the extension's own. Tests pass their own database and clock.
 * The background is the only writer; pages read the table with live queries and send commands.
 */
export function createTaskStore(db: AviCopilotDb = defaultDb, options: { now?: () => number } = {}) {
  const now = options.now ?? (() => Date.now());

  /** The tasks of one workspace (null: in none). IndexedDB does not index null, so "none" is a scan. */
  const inWorkspace = (workspaceId: string | null): Promise<Task[]> =>
    workspaceId === null
      ? db.tasks.filter(task => task.workspaceId === null).toArray()
      : db.tasks.where('workspaceId').equals(workspaceId).toArray();

  /** A task by its id, or by the id of a task merged into it: a marker written before a merge still finds it. */
  const find = async (id: string): Promise<Task | undefined> =>
    (await db.tasks.get(id)) ?? (await db.tasks.where('mergedIds').equals(id).first());

  const change = (id: string, edit: (task: Task) => Task | null): Promise<Task | null> =>
    db.transaction('rw', db.tasks, async () => {
      const task = await find(id);
      if (!task) return null;
      const next = edit(task);
      if (!next) return task;
      const saved = { ...next, id: task.id, createdAt: task.createdAt, updatedAt: now() };
      await db.tasks.put(saved);
      return saved;
    });

  const store = {
    db,

    get: (id: string): Promise<Task | undefined> => find(id),

    /** Adds a task as given, with no matching: what the user adds by hand. */
    async add(input: NewTask): Promise<Task> {
      const at = now();
      const task: Task = {
        id: newTaskId(),
        title: oneLine(input.title, 200),
        ...(input.detail ? { detail: input.detail.trim().slice(0, 2000) } : {}),
        workspaceId: input.workspaceId,
        workspaceSetBy: input.workspaceSetBy ?? 'avi',
        ownerId: input.ownerId ?? null,
        ownerName: ownerNameOf(input.ownerName),
        status: 'open',
        ...(input.due ? { due: input.due } : {}),
        ...(input.dueText ? { dueText: oneLine(input.dueText, 80) } : {}),
        source: input.source ?? { kind: 'manual' },
        seenIn: input.source?.id ? [input.source.id] : [],
        links: input.links ?? [],
        externalRefs: [],
        createdAt: at,
        updatedAt: at,
      };
      if (!task.title) throw new Error('A task needs a title');
      await db.tasks.add(task);
      return task;
    },

    /**
     * Changes a task's words, owner's name, due date or links. Its id, workspace and status change elsewhere. Giving it
     * to a different name clears the person it was linked to.
     */
    update(id: string, changes: TaskChanges): Promise<Task | null> {
      return change(id, task => {
        const next: Task = {
          ...task,
          ...changes,
          title: changes.title !== undefined ? oneLine(changes.title, 200) || task.title : task.title,
          ...(changes.ownerName !== undefined ? { ownerName: ownerNameOf(changes.ownerName) } : {}),
        };
        // A new name is a new person: the link to the old one (setOwner) no longer holds
        if (next.ownerName !== task.ownerName) next.ownerId = null;
        // A field set to undefined is cleared
        for (const key of ['detail', 'due', 'dueText', 'followUp'] as const)
          if (next[key] === undefined) delete next[key];
        return next;
      });
    },

    /** Closes, drops or reopens a task. Reopening clears who closed it and when. */
    setStatus(id: string, status: TaskStatus, by: 'avi' | 'ava'): Promise<Task | null> {
      return change(id, task => {
        if (task.status === status) return null;
        if (status === 'open') {
          const reopened: Task = { ...task, status };
          delete reopened.doneAt;
          delete reopened.doneBy;
          return reopened;
        }
        return { ...task, status, doneAt: now(), doneBy: by };
      });
    },

    /** Links a task to a person (Part 5). The name as said stays unless a new one is given. */
    setOwner(taskId: string, personId: string | null, name?: string | null): Promise<Task | null> {
      return change(taskId, task => ({
        ...task,
        ownerId: personId,
        ...(name !== undefined ? { ownerName: ownerNameOf(name) } : {}),
      }));
    },

    /** Tasks that match every part of the query, oldest first. */
    async list(query: TaskListQuery = {}): Promise<Task[]> {
      const statuses = query.status === undefined ? null : ([] as TaskStatus[]).concat(query.status);
      const rows =
        query.workspaceId !== undefined
          ? await inWorkspace(query.workspaceId)
          : statuses?.length === 1
            ? await db.tasks.where('status').equals(statuses[0]).toArray()
            : await db.tasks.toArray();
      return rows
        .filter(
          task =>
            (!statuses || statuses.includes(task.status)) &&
            (query.ownerId === undefined || task.ownerId === query.ownerId) &&
            (query.dueBefore === undefined || (task.due !== undefined && task.due < query.dueBefore)),
        )
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    },

    /**
     * Makes two tasks one: the kept one takes the other's mentions, links and references, fills its gaps (owner,
     * due, detail), and answers to the other's id from then on. Its own status stays.
     */
    merge(keepId: string, dropId: string): Promise<Task | null> {
      return db.transaction('rw', db.tasks, async () => {
        const keep = await find(keepId);
        const drop = await find(dropId);
        if (!keep || !drop || keep.id === drop.id) return keep ?? null;
        const union = <T>(a: T[], b: T[], key: (item: T) => string) => [
          ...new Map([...a, ...b].map(item => [key(item), item])).values(),
        ];
        const merged: Task = {
          ...keep,
          detail: keep.detail ?? drop.detail,
          ownerId: keep.ownerId ?? drop.ownerId,
          ownerName: keep.ownerName ?? drop.ownerName,
          due: keep.due ?? drop.due,
          dueText: keep.dueText ?? drop.dueText,
          seenIn: [...new Set([...keep.seenIn, ...drop.seenIn])],
          links: union(keep.links, drop.links, link => link.url),
          externalRefs: union(keep.externalRefs, drop.externalRefs, ref => `${ref.system}:${ref.id}`),
          mergedIds: [...new Set([...(keep.mergedIds ?? []), drop.id, ...(drop.mergedIds ?? [])])],
          createdAt: Math.min(keep.createdAt, drop.createdAt),
          updatedAt: now(),
        };
        // Drop undefined gaps so the record stays as small as the shape says
        for (const key of ['detail', 'due', 'dueText'] as const) if (merged[key] === undefined) delete merged[key];
        await db.tasks.delete(drop.id);
        await db.tasks.put(merged);
        return merged;
      });
    },

    /**
     * Moves tasks to a workspace (null: none). A rule or Ava never moves a task whose workspace the user chose
     * (rule 8). Returns the tasks that moved.
     */
    move(ids: string[], workspaceId: string | null, by: WorkspaceSetBy): Promise<Task[]> {
      return db.transaction('rw', db.tasks, async () => {
        const moved: Task[] = [];
        for (const id of ids) {
          const task = await find(id);
          if (!task || (by !== 'avi' && task.workspaceSetBy === 'avi')) continue;
          if (task.workspaceId === workspaceId && task.workspaceSetBy === by) continue;
          const next = { ...task, workspaceId, workspaceSetBy: by, updatedAt: now() };
          await db.tasks.put(next);
          moved.push(next);
        }
        return moved;
      });
    },

    /**
     * The one way a source's mention becomes a task (`recordTask`). An existing task that is the same one (the rules
     * in ./match.ts) takes the mention: the source joins `seenIn` and the gaps (owner, due) are filled. A closed
     * task stays closed. Otherwise a new open task is made. Recording the same source twice changes nothing.
     */
    async record(candidate: TaskCandidate): Promise<{ task: Task; added: boolean } | null> {
      const at = candidate.at ?? now();
      const title = oneLine(candidate.title, 200);
      if (title.length < 2) return null;
      const dueText = candidate.dueText ? oneLine(candidate.dueText, 80) : undefined;
      const due = candidate.due ?? dueFromText(dueText, at);
      const ownerName = ownerNameOf(candidate.ownerName);
      const sourceId = candidate.source.id;
      const quote = candidate.source.quote ? oneLine(candidate.source.quote, 300) : undefined;
      const workspaceId = candidate.workspaceId ?? null;

      return db.transaction('rw', db.tasks, async () => {
        const same = findSameTask(await inWorkspace(workspaceId), { ...candidate, title, ownerName }, at);
        if (same) {
          const seen = sourceId !== undefined && !same.seenIn.includes(sourceId);
          const next: Task = {
            ...same,
            seenIn: seen ? [...same.seenIn, sourceId] : same.seenIn,
            ownerName: same.ownerName ?? ownerName,
            ownerId: same.ownerId ?? candidate.ownerId ?? null,
            ...(same.due || !due ? {} : { due }),
            ...(same.dueText || !dueText ? {} : { dueText }),
            ...(same.detail || !candidate.detail ? {} : { detail: candidate.detail.trim().slice(0, 2000) }),
            updatedAt: Math.max(same.updatedAt, at),
          };
          const changed = JSON.stringify(next) !== JSON.stringify(same);
          if (changed) await db.tasks.put(next);
          return { task: next, added: false };
        }
        const task: Task = {
          id: newTaskId(),
          title,
          ...(candidate.detail ? { detail: candidate.detail.trim().slice(0, 2000) } : {}),
          workspaceId,
          workspaceSetBy: candidate.workspaceSetBy ?? 'rule',
          ownerId: candidate.ownerId ?? null,
          ownerName,
          status: 'open',
          ...(due ? { due } : {}),
          ...(dueText ? { dueText } : {}),
          source: { kind: candidate.source.kind, ...(sourceId ? { id: sourceId } : {}), ...(quote ? { quote } : {}) },
          seenIn: sourceId ? [sourceId] : [],
          links: [],
          externalRefs: [],
          createdAt: at,
          updatedAt: at,
        };
        await db.tasks.add(task);
        return { task, added: true };
      });
    },

    /**
     * "Close everything older than two weeks": open tasks nobody mentioned or changed for that long are dropped
     * (not done: nobody said they were). Returns how many.
     */
    closeOlderThan(age: number = OLD_TASK_AGE): Promise<number> {
      return db.transaction('rw', db.tasks, async () => {
        const before = now() - age;
        const old = (await db.tasks.where('status').equals('open').toArray()).filter(task => task.updatedAt < before);
        const at = now();
        await db.tasks.bulkPut(
          old.map(task => ({ ...task, status: 'dropped', doneAt: at, doneBy: 'avi', updatedAt: at })),
        );
        return old.length;
      });
    },

    /** Calls the listener after any change to the board, made in any part of the extension. Returns a stop. */
    onChange(listener: (tasks: Task[]) => void): () => void {
      let first = true;
      const subscription = liveQuery(() => db.tasks.toArray()).subscribe({
        next: tasks => {
          if (first) {
            first = false;
            return;
          }
          listener(tasks);
        },
        error: () => {},
      });
      return () => subscription.unsubscribe();
    },
  };
  return store;
}

export type TaskStore = ReturnType<typeof createTaskStore>;

export const taskStore = createTaskStore();

/** The one way a source's mention of something to do reaches the board (see TaskStore.record). */
export const recordTask = (candidate: TaskCandidate) => taskStore.record(candidate);
