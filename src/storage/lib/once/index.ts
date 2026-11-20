import { db as defaultDb } from '../threads/db';
import type { AviCopilotDb } from '../threads/db';
import type { OnceRecord, OnceStep } from './types';

export * from './types';

export const onceKey = (step: Pick<OnceStep, 'taskId' | 'what' | 'target'>): string =>
  `${step.taskId}|${step.what}|${step.target}`;

// A step that still stands in the way of doing it again: it happened, or it may have
const stands = (record: OnceRecord | undefined): record is OnceRecord =>
  record !== undefined && (record.status === 'started' || record.status === 'done');

// Why a record stands in the way of a step
export type OnceWhy =
  // The step itself is done or was started
  | 'same'
  // Another step in this chat, on the same site or tool, was cut off before its result was recorded
  | 'cut_off'
  // An earlier run of this task finished a step on the same site or tool: this one may be it in other words
  | 'earlier';

export interface OnceBlock {
  record: OnceRecord;
  why: OnceWhy;
}

export type OnceClaim =
  // "started" is written: the caller may act, and must then call finish or fail
  | { fresh: true; record: OnceRecord }
  // A record stands in the way: the caller must not act
  | ({ fresh: false } & OnceBlock);

/**
 * The do-once records, over a database that defaults to the extension's own. Tests pass their own database.
 */
export function createOnceStore(db: AviCopilotDb = defaultDb) {
  const store = {
    db,

    get(key: string): Promise<OnceRecord | undefined> {
      return db.doOnce.get(key);
    },

    /** Every record of a task, oldest first. */
    async forTask(taskId: string): Promise<OnceRecord[]> {
      return (await db.doOnce.where('taskId').equals(taskId).toArray()).sort((a, b) => a.startedAt - b.startedAt);
    },

    /** The steps of a chat that were cut off and that the user has not yet looked at, oldest first. */
    async cutOff(threadId: string): Promise<OnceRecord[]> {
      return (await db.doOnce.where('threadId').equals(threadId).toArray())
        .filter(record => record.status === 'started' && record.ackAt === null)
        .sort((a, b) => a.startedAt - b.startedAt);
    },

    /**
     * The record that stands in the way of a step, if any. In order:
     * - the step itself, when it is done or was started;
     * - a step on the same site or tool that was cut off, in this chat, whichever request it belonged to. It may
     *   be this one in other words (a retry seldom writes a message the same way twice), and asking again in the
     *   same chat ("continue") does not make its outcome known;
     * - a step on the same site or tool that an earlier run of this task finished: a retried run that sends
     *   there again may be repeating it in other words, which only the user can tell.
     *
     * @param since - When the current run started; steps done before it belong to an earlier run of the task
     */
    async blocking(step: OnceStep, since = 0): Promise<OnceBlock | null> {
      const same = await db.doOnce.get(onceKey(step));
      if (stands(same)) return { record: same, why: 'same' };
      const cutOff = (await store.cutOff(step.threadId)).find(record => record.scope === step.scope);
      if (cutOff) return { record: cutOff, why: 'cut_off' };
      const earlier = (await store.forTask(step.taskId))
        .filter(record => record.status === 'done' && record.scope === step.scope && record.startedAt < since)
        .at(-1);
      return earlier ? { record: earlier, why: 'earlier' } : null;
    },

    /**
     * Writes "started" for a step before it acts, in one transaction, so two writers can never both start it.
     *
     * @param options.again - The user was shown the record that stands in the way and chose to run the step.
     *   Without it, a step with anything in its way is never started.
     * @param options.ack - The key of the cut-off record the user was shown. It stops holding back other steps;
     *   it still holds back itself.
     * @param options.since - When the current run started (see `blocking`)
     */
    async begin(step: OnceStep, options: { again?: boolean; ack?: string; since?: number } = {}): Promise<OnceClaim> {
      const key = onceKey(step);
      return db.transaction('rw', db.doOnce, async (): Promise<OnceClaim> => {
        if (!options.again) {
          const block = await store.blocking(step, options.since);
          if (block) return { fresh: false, ...block };
        }
        const now = Date.now();
        if (options.again && options.ack && options.ack !== key) {
          await db.doOnce
            .where('key')
            .equals(options.ack)
            .and(record => record.status === 'started')
            .modify({ ackAt: now });
        }
        const existing = await db.doOnce.get(key);
        const record: OnceRecord = {
          ...step,
          key,
          status: 'started',
          attempts: (existing?.attempts ?? 0) + 1,
          redone: (existing?.redone ?? 0) + (existing?.status === 'done' ? 1 : 0),
          startedAt: now,
          finishedAt: null,
          result: null,
          toldAt: null,
          ackAt: null,
        };
        await db.doOnce.put(record);
        return { fresh: true, record };
      });
    },

    /** Records that a started step went through. A step that is not at "started" is left as it is. */
    async finish(key: string, result: string): Promise<void> {
      await db.doOnce
        .where('key')
        .equals(key)
        .and(record => record.status === 'started')
        .modify({ status: 'done', finishedAt: Date.now(), result });
    },

    /** Records that a started step certainly did not happen, so it may be tried again. */
    async fail(key: string, reason: string): Promise<void> {
      await db.doOnce
        .where('key')
        .equals(key)
        .and(record => record.status === 'started')
        .modify({ status: 'failed', finishedAt: Date.now(), result: reason });
    },

    /** Notes that the model was told the step exists. */
    async told(key: string, at = Date.now()): Promise<void> {
      await db.doOnce.update(key, { toldAt: at });
    },

    /** Removes records started before a time; the tasks they guarded are long over. */
    async prune(before: number): Promise<number> {
      return db.doOnce.where('startedAt').below(before).delete();
    },
  };
  return store;
}

export type OnceStore = ReturnType<typeof createOnceStore>;

export const onceStore = createOnceStore();
