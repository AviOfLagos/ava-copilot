import { db as defaultDb } from '../threads/db';
import type { AviCopilotDb } from '../threads/db';
import type { OnceRecord, OnceStep } from './types';

export * from './types';

export const onceKey = (step: Pick<OnceStep, 'taskId' | 'what' | 'target'>): string =>
  `${step.taskId}|${step.what}|${step.target}`;

// A step that still stands in the way of doing it again: it happened, or it may have
const stands = (record: OnceRecord | undefined): record is OnceRecord =>
  record !== undefined && (record.status === 'started' || record.status === 'done');

export type OnceClaim =
  // "started" is written: the caller may act, and must then call finish or fail
  | { fresh: true; record: OnceRecord }
  // The step already happened or may have: the caller must not act
  | { fresh: false; record: OnceRecord };

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

    /**
     * The record that stands in the way of a step, if any: the step itself when it is done or was started, else a
     * step of the same task that was cut off on the same site or tool. A cut-off step may be this one in other
     * words (a retry seldom writes a message the same way twice), so it blocks too.
     */
    async blocking(step: OnceStep): Promise<OnceRecord | null> {
      const same = await db.doOnce.get(onceKey(step));
      if (stands(same)) return same;
      const cutOff = (await store.forTask(step.taskId)).find(
        record => record.status === 'started' && record.scope === step.scope,
      );
      return cutOff ?? null;
    },

    /**
     * Writes "started" for a step before it acts, in one transaction, so two writers can never both start it.
     *
     * @param options.again - The user saw that the step (or a cut-off one on the same site or tool) already
     *   exists and chose to run it again. Without it, a step that is done or was started is never started again.
     */
    async begin(step: OnceStep, options: { again?: boolean } = {}): Promise<OnceClaim> {
      const key = onceKey(step);
      return db.transaction('rw', db.doOnce, async (): Promise<OnceClaim> => {
        const existing = await db.doOnce.get(key);
        const cutOff = (await db.doOnce.where('taskId').equals(step.taskId).toArray()).filter(
          record => record.status === 'started' && record.scope === step.scope && record.key !== key,
        );
        if (!options.again) {
          if (stands(existing)) return { fresh: false, record: existing };
          if (cutOff.length > 0) return { fresh: false, record: cutOff[0] };
        }
        const now = Date.now();
        for (const record of cutOff) {
          await db.doOnce.update(record.key, { status: 'superseded', finishedAt: now });
        }
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
