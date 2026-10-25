import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AviCopilotDb } from '../../threads/db';
import { AMBIENT_TTL_DAYS, continuesSession, createAmbientStore, SESSION_GAP_MS } from '../store';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 25, 14, 0);

let store: ReturnType<typeof createAmbientStore>;

beforeEach(() => {
  store = createAmbientStore(new AviCopilotDb(`ambient-${crypto.randomUUID()}`));
});

const say = (at: number, text = `words at ${at}`) => store.add({ startedAt: at, endedAt: at + 3000, text });

describe('ambient sessions', () => {
  it('keeps talk with short gaps in one session and starts a new one after a long gap', async () => {
    const first = await say(T0);
    const second = await say(T0 + 4 * MIN);
    // The gap counts from the end of the last words (each lasts 3 s)
    const third = await say(T0 + 4 * MIN + 3000 + SESSION_GAP_MS);
    expect(second.session.id).toBe(first.session.id);
    expect(third.session.id).not.toBe(first.session.id);
    const [latest, older] = await store.sessions();
    expect(latest.id).toBe(third.session.id);
    expect(older).toMatchObject({ utteranceCount: 2, startedAt: T0, endedAt: T0 + 4 * MIN + 3000 });
    expect((await store.utterances(older.id)).map(u => u.speaker)).toEqual(['unknown', 'unknown']);
  });

  it('decides continuation from the gap after the session ends', () => {
    expect(continuesSession(undefined, T0)).toBe(false);
    expect(continuesSession({ endedAt: T0 }, T0 + SESSION_GAP_MS - 1)).toBe(true);
    expect(continuesSession({ endedAt: T0 }, T0 + SESSION_GAP_MS)).toBe(false);
  });

  it('forgets what ended after a moment, trimming or removing the sessions it touched', async () => {
    const kept = await say(T0);
    await say(T0 + 2 * MIN);
    const later = await say(T0 + 30 * MIN);
    const result = await store.forgetSince(T0 + MIN);
    expect(result.removed).toEqual([later.session.id]);
    expect(result.changed).toEqual([kept.session.id]);
    const sessions = await store.sessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ utteranceCount: 1, endedAt: T0 + 3000 });
    expect((await store.utterances(kept.session.id)).map(u => u.startedAt)).toEqual([T0]);
  });

  it('drops what is older than the retention', async () => {
    const old = await say(T0);
    const fresh = await say(T0 + (AMBIENT_TTL_DAYS + 1) * 24 * 60 * MIN);
    const cutoff = store.retentionCutoff(T0 + (AMBIENT_TTL_DAYS + 1) * 24 * 60 * MIN);
    const result = await store.removeOlderThan(cutoff);
    expect(result.removed).toEqual([old.session.id]);
    expect((await store.sessions()).map(s => s.id)).toEqual([fresh.session.id]);
  });
});
