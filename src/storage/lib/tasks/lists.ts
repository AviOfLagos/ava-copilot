import { db as defaultDb } from '../threads/db';
import type { AviCopilotDb } from '../threads/db';

// The task lists Ava sent on WhatsApp (docs/pm-desk.md, Part 8): which tasks a message carried, in its order, by
// ids only. A number Avi answers with is read against the list he quoted, else the latest numbered one, so it
// always maps to the tasks he saw, however old the list.

export interface TaskListRecord {
  // The WhatsApp id of the message Ava sent; 'local:<uuid>' when the client gave none (it can then not be quoted)
  messageId: string;
  // In the order the message numbered them: number 1 is taskIds[0]
  taskIds: string[];
  sentAt: number;
  // A numbered list a bare "done 2" is read against; false for a message that only confirms one task ("Added: …")
  // and for a list meant to be forwarded (one person's after a call): those take numbers only in a quoted reply
  numbered: boolean;
  // What the message was: an answer to his command, the morning brief, or a list Ava sent first. On a one-task
  // message a ✅ always closes it, a 👍 only on a list Ava sent first (on her answers and the brief it means "ok")
  kind?: 'answer' | 'brief' | 'list';
  // A ✅ or 👍 on this one-task message closed its task: taking the reaction back reopens it
  closedByReaction?: boolean;
}

// Lists older than this are let go: a quoted reply to one says it is too old to read
const KEEP_MS = 90 * 24 * 60 * 60 * 1000;
const TASKS_MAX = 50;

export function createTaskListStore(db: AviCopilotDb = defaultDb, options: { now?: () => number } = {}) {
  const now = options.now ?? (() => Date.now());
  return {
    db,

    /** Keeps which tasks a sent message carried. */
    async save(record: Omit<TaskListRecord, 'sentAt'> & { sentAt?: number }): Promise<TaskListRecord> {
      const saved: TaskListRecord = {
        messageId: record.messageId,
        taskIds: record.taskIds.slice(0, TASKS_MAX),
        sentAt: record.sentAt ?? now(),
        numbered: record.numbered,
        ...(record.kind ? { kind: record.kind } : {}),
        ...(record.closedByReaction ? { closedByReaction: true } : {}),
      };
      await db.taskLists.put(saved);
      return saved;
    },

    get: (messageId: string): Promise<TaskListRecord | undefined> => db.taskLists.get(messageId),

    /**
     * The newest numbered list sent before a moment: what a bare number in a message that came then means. A list
     * that went out after he wrote is not one he had seen.
     */
    latestNumbered: (before = Number.POSITIVE_INFINITY): Promise<TaskListRecord | undefined> =>
      db.taskLists
        .where('sentAt')
        .belowOrEqual(before)
        .reverse()
        .filter(record => record.numbered)
        .first(),

    async setClosedByReaction(messageId: string, closed: boolean): Promise<void> {
      await db.taskLists.update(messageId, { closedByReaction: closed });
    },

    /** Lets go of lists older than KEEP_MS. */
    prune: (): Promise<number> =>
      db.taskLists
        .where('sentAt')
        .below(now() - KEEP_MS)
        .delete(),
  };
}

export type TaskListStore = ReturnType<typeof createTaskListStore>;

export const taskListStore = createTaskListStore();
