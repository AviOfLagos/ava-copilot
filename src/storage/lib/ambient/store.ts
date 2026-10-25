import { db as defaultDb } from '../threads/db';
import type { AviCopilotDb } from '../threads/db';
import type { AmbientSession, AmbientSpeaker, AmbientUtterance } from './types';

// Continuous talk with a gap shorter than this is one session
export const SESSION_GAP_MS = 10 * 60 * 1000;
// Utterances (and the sessions they leave empty) are kept this long
export const AMBIENT_TTL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether an utterance starting at `at` carries on `session` rather than starting a new one. */
export function continuesSession(session: Pick<AmbientSession, 'endedAt'> | undefined, at: number): boolean {
  return !!session && at >= session.endedAt - 1000 && at - session.endedAt < SESSION_GAP_MS;
}

/**
 * Ambient sessions and their utterances, over a database that defaults to the extension's own. The background
 * is the only writer; pages read the tables with live queries.
 */
export function createAmbientStore(db: AviCopilotDb = defaultDb) {
  const store = {
    db,

    /** The newest session, open or not. */
    latestSession: () => db.ambientSessions.orderBy('startedAt').last(),

    session: (id: string) => db.ambientSessions.get(id),

    /** Newest first. */
    sessions: (limit = 50) => db.ambientSessions.orderBy('startedAt').reverse().limit(limit).toArray(),

    /** A session's utterances in the order they were said. */
    utterances: (sessionId: string) =>
      db.ambientUtterances
        .where('[sessionId+startedAt]')
        .between([sessionId, -Infinity], [sessionId, Infinity])
        .toArray(),

    /** Files an utterance in the open session, or in a new one after a long enough gap. */
    async add(fields: { startedAt: number; endedAt: number; text: string; speaker?: AmbientSpeaker }): Promise<{
      session: AmbientSession;
      utterance: AmbientUtterance;
    }> {
      return db.transaction('rw', db.ambientSessions, db.ambientUtterances, async () => {
        const latest = await store.latestSession();
        const session: AmbientSession = continuesSession(latest, fields.startedAt)
          ? {
              ...latest!,
              endedAt: Math.max(latest!.endedAt, fields.endedAt),
              utteranceCount: latest!.utteranceCount + 1,
            }
          : {
              id: crypto.randomUUID(),
              startedAt: fields.startedAt,
              endedAt: fields.endedAt,
              utteranceCount: 1,
              workspaceId: null,
            };
        const utterance: AmbientUtterance = {
          id: crypto.randomUUID(),
          sessionId: session.id,
          startedAt: fields.startedAt,
          endedAt: fields.endedAt,
          speaker: fields.speaker ?? 'unknown',
          text: fields.text,
        };
        await db.ambientSessions.put(session);
        await db.ambientUtterances.add(utterance);
        return { session, utterance };
      });
    },

    /**
     * Deletes every utterance that ended after `since`, and the sessions that leaves empty; sessions that keep
     * some words are trimmed to them. Returns the ids of the sessions it changed or removed.
     */
    async forgetSince(since: number): Promise<{ changed: string[]; removed: string[] }> {
      return db.transaction('rw', db.ambientSessions, db.ambientUtterances, async () => {
        const gone = await db.ambientUtterances.where('endedAt').above(since).toArray();
        await db.ambientUtterances.bulkDelete(gone.map(utterance => utterance.id));
        return store.settle([...new Set(gone.map(utterance => utterance.sessionId))]);
      });
    },

    /** Deletes what is older than the retention, and the sessions that leaves empty. */
    async removeOlderThan(cutoff: number): Promise<{ changed: string[]; removed: string[] }> {
      return db.transaction('rw', db.ambientSessions, db.ambientUtterances, async () => {
        const old = await db.ambientUtterances.where('endedAt').below(cutoff).toArray();
        await db.ambientUtterances.bulkDelete(old.map(utterance => utterance.id));
        return store.settle([...new Set(old.map(utterance => utterance.sessionId))]);
      });
    },

    retentionCutoff: (now = Date.now(), days = AMBIENT_TTL_DAYS) => now - days * DAY_MS,

    /** Recounts sessions after deletions: an empty one goes, the others shrink to the words they still have. */
    async settle(sessionIds: string[]): Promise<{ changed: string[]; removed: string[] }> {
      const changed: string[] = [];
      const removed: string[] = [];
      for (const id of sessionIds) {
        const session = await db.ambientSessions.get(id);
        if (!session) continue;
        const left = await store.utterances(id);
        if (!left.length) {
          await db.ambientSessions.delete(id);
          removed.push(id);
          continue;
        }
        await db.ambientSessions.put({
          ...session,
          startedAt: left[0].startedAt,
          endedAt: Math.max(...left.map(utterance => utterance.endedAt)),
          utteranceCount: left.length,
        });
        changed.push(id);
      }
      return { changed, removed };
    },

    async wipe(): Promise<void> {
      await db.transaction('rw', db.ambientSessions, db.ambientUtterances, async () => {
        await db.ambientUtterances.clear();
        await db.ambientSessions.clear();
      });
    },
  };
  return store;
}

export type AmbientStore = ReturnType<typeof createAmbientStore>;

export const ambientStore = createAmbientStore();
