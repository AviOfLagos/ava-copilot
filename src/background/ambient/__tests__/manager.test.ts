import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { AviCopilotDb, createAmbientStore, DEFAULT_AMBIENT_SETTINGS } from '@extension/storage';
import type { AmbientSettingsConfig } from '@extension/storage';
import { AmbientManager } from '../manager';
import type { AmbientDeps } from '../manager';

const NOW = Date.UTC(2026, 9, 25, 14, 0);
const STT = { engine: 'moonshine' as const, model: 'moonshine-base' as const, webgpu: false };
const TINY = { engine: 'moonshine' as const, model: 'moonshine-tiny' as const, webgpu: false };

let settings: AmbientSettingsConfig;
let store: ReturnType<typeof createAmbientStore>;
type Kb = ReturnType<AmbientDeps['kb']>;
let kb: { indexAmbient: Mock<Kb['indexAmbient']>; forget: Mock<Kb['forget']> };
let offscreen: { start: Mock<AmbientDeps['offscreen']['start']>; stop: Mock<AmbientDeps['offscreen']['stop']> };
let indicate: Mock<AmbientDeps['indicate']>;
let now: number;

function manager(over: Partial<AmbientDeps> = {}) {
  return new AmbientManager({
    settings: {
      getSettings: async () => ({ ...settings }),
      updateSettings: async changes => {
        settings = { ...settings, ...changes };
      },
    },
    store,
    kb: () => kb,
    offscreen,
    stt: async () => ({ stt: STT, lowPowerStt: TINY }),
    nameWords: async () => ['ava'],
    indicate,
    now: () => now,
    indexDelayMs: 50,
    ...over,
  });
}

beforeEach(() => {
  settings = { ...DEFAULT_AMBIENT_SETTINGS, mode: 'listen' };
  store = createAmbientStore(new AviCopilotDb(`ambient-manager-${crypto.randomUUID()}`));
  kb = {
    indexAmbient: vi.fn<Kb['indexAmbient']>().mockResolvedValue(null),
    forget: vi.fn<Kb['forget']>().mockResolvedValue(undefined),
  };
  offscreen = {
    start: vi.fn<AmbientDeps['offscreen']['start']>().mockResolvedValue({ ok: true }),
    stop: vi.fn<AmbientDeps['offscreen']['stop']>().mockResolvedValue(undefined),
  };
  indicate = vi.fn<AmbientDeps['indicate']>();
  now = NOW;
});

afterEach(() => {
  vi.useRealTimers();
});

const heard = (m: AmbientManager, text: string, at = now) => m.heard({ text, startedAt: at - 2000, endedAt: at });

describe('AmbientManager.sync', () => {
  it('starts the listener with the local recogniser, the low-power one and the name', async () => {
    const m = manager();
    expect(await m.sync()).toEqual({ ok: true, error: undefined, micDenied: undefined });
    expect(offscreen.start).toHaveBeenCalledWith({ stt: STT, lowPowerStt: TINY, offRecord: false, nameWords: ['ava'] });
    expect(indicate).toHaveBeenLastCalledWith({ mode: 'listen', offRecord: false, running: true });
  });

  it('says so when no recogniser is installed, and shows the problem on the toolbar', async () => {
    const m = manager({ stt: async () => null });
    expect(await m.sync()).toEqual({ ok: false, error: 'missing_stt' });
    expect(offscreen.start).not.toHaveBeenCalled();
    expect(indicate).toHaveBeenLastCalledWith({ mode: 'listen', offRecord: false, running: false });
  });

  it('stops the listener when turned off', async () => {
    const m = manager();
    await m.sync();
    settings.mode = 'off';
    await m.sync();
    expect(offscreen.stop).toHaveBeenCalledTimes(1);
    expect(indicate).toHaveBeenLastCalledWith({ mode: 'off', offRecord: false, running: false });
  });
});

describe('AmbientManager.heard', () => {
  it('keeps ordinary talk in a session, and nothing in the knowledge base without the cloud permission', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const m = manager();
    await heard(m, 'We should ship the Ellum page on Friday');
    const [session] = await store.sessions();
    expect((await store.utterances(session.id)).map(u => u.text)).toEqual(['We should ship the Ellum page on Friday']);
    await vi.advanceTimersByTimeAsync(100);
    expect(kb.indexAmbient).not.toHaveBeenCalled();
  });

  it('indexes the session a little after the last words when the cloud permission is on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    settings.cloudAllowed = true;
    const m = manager();
    await heard(m, 'first line');
    await heard(m, 'second line', now + 1000);
    expect(kb.indexAmbient).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    // The database answers on real time
    vi.useRealTimers();
    await vi.waitFor(() => expect(kb.indexAmbient).toHaveBeenCalledTimes(1));
    const [, utterances] = kb.indexAmbient.mock.calls[0];
    expect(utterances.map(u => u.text)).toEqual(['first line', 'second line']);
  });

  it('obeys a switch and never keeps it', async () => {
    const m = manager();
    await heard(m, 'Ava, feel free to chime in');
    expect(settings.mode).toBe('companion');
    await heard(m, 'Ava, off the record');
    expect(settings).toMatchObject({ offRecord: true, offRecordSince: NOW });
    expect(await store.sessions()).toHaveLength(0);
  });

  it('keeps nothing off the record or when off, until back on the record', async () => {
    const m = manager();
    settings.offRecord = true;
    await heard(m, 'the private part');
    expect(await store.sessions()).toHaveLength(0);
    await m.backOnRecord();
    expect(settings.offRecord).toBe(false);
    await heard(m, 'the public part');
    settings.mode = 'off';
    await heard(m, 'after it was turned off');
    const [session] = await store.sessions();
    expect((await store.utterances(session.id)).map(u => u.text)).toEqual(['the public part']);
  });

  it('"go quiet" turns listening off and clears off the record', async () => {
    const m = manager();
    settings.offRecord = false;
    await heard(m, 'Ava, go quiet');
    expect(settings).toMatchObject({ mode: 'off', offRecord: false });
  });

  it('never trusts a time from the future', async () => {
    const m = manager();
    await m.heard({ text: 'hello there', startedAt: now + 60_000, endedAt: now + 90_000 });
    const [session] = await store.sessions();
    expect(session.endedAt).toBe(now);
  });
});

describe('forgetting and retention', () => {
  it('"forget the last ten minutes" deletes it here and in the knowledge base', async () => {
    const m = manager();
    await heard(m, 'an hour ago', now - 60 * 60_000);
    await heard(m, 'just now');
    await heard(m, 'Ava, forget the last ten minutes');
    const sessions = await store.sessions();
    expect(sessions).toHaveLength(1);
    expect((await store.utterances(sessions[0].id)).map(u => u.text)).toEqual(['an hour ago']);
    expect(kb.forget).toHaveBeenCalledWith('ambient', expect.any(String));
  });

  it('a trimmed session is indexed again when the cloud permission is on', async () => {
    settings.cloudAllowed = true;
    const m = manager();
    await heard(m, 'kept', now - 3 * 60_000);
    await heard(m, 'forgotten');
    kb.indexAmbient.mockClear();
    await m.forget(1);
    expect(kb.indexAmbient).toHaveBeenCalledTimes(1);
    expect(kb.indexAmbient.mock.calls[0][1].map(u => u.text)).toEqual(['kept']);
  });

  it('drops sessions past the retention', async () => {
    const m = manager();
    await heard(m, 'long ago', now - 40 * 24 * 60 * 60_000);
    await heard(m, 'today');
    expect(await m.applyRetention()).toBe(1);
    expect(await store.sessions()).toHaveLength(1);
  });

  it('turning the cloud permission off takes every session out of the knowledge base', async () => {
    const m = manager();
    await heard(m, 'one', now - 60 * 60_000);
    await heard(m, 'two');
    await m.cloudChanged(false);
    expect(kb.forget).toHaveBeenCalledTimes(2);
    settings.cloudAllowed = true;
    await m.cloudChanged(true);
    expect(kb.indexAmbient).toHaveBeenCalledTimes(2);
  });
});
