import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EconomyTurnReply, EconomyTurnRequest } from '../../../background/voice/engines/protocol';
import type { VoiceEvents } from '../../voice';
import { EconomySession, TURN_LIMIT_MS, TURN_TOO_LONG } from '../economy';
import type { EconomyDeps, EconomyOptions } from '../economy';
import { STT_STALLED, withTimeLimit } from '../engines';
import type { SttEngine } from '../engines';

// A voice conversation must never get stuck: a recogniser or a turn that never answers is given up on, and the
// conversation listens again (it used to wait forever, even after a restart, which got the same stuck engine).

const CHUNK = 4096;
const speech = () => Float32Array.from({ length: CHUNK }, (_, i) => 0.2 * Math.sin(i / 3));
const quiet = () => new Float32Array(CHUNK);
// Chunks of quiet that end an utterance: past the 1.2 s hangover
const PAUSE = 5;
const never = <T>() => new Promise<T>(() => {});

const OPTIONS: EconomyOptions = {
  mode: 'economy',
  instructions: 'You are Ava Copilot.',
  tools: [],
  economy: {
    stt: { engine: 'moonshine', model: 'moonshine-tiny', webgpu: false },
    tts: { engine: 'kitten', voice: 'Bella', rate: 1 },
  },
};

function setup(stt: SttEngine, ask: (request: EconomyTurnRequest) => Promise<EconomyTurnReply>) {
  let mic: (samples: Float32Array) => void = () => {};
  let finishSpeaking: () => void = () => {};
  const deps = {
    openMic: vi.fn(async (onChunk: (samples: Float32Array) => void) => {
      mic = onChunk;
      return () => {};
    }),
    loadStt: vi.fn(async () => stt),
    releaseStt: vi.fn(),
    speak: vi.fn(() => new Promise<void>(resolve => (finishSpeaking = resolve))),
    stopSpeaking: vi.fn(() => finishSpeaking()),
    warmVoice: vi.fn(async () => {}),
    ask: vi.fn(ask),
  } satisfies EconomyDeps;
  const events = { onTurn: vi.fn(), onTool: vi.fn(), onStatus: vi.fn(), onUsage: vi.fn() } satisfies VoiceEvents;
  const session = new EconomySession(OPTIONS, events, deps);
  const say = () => {
    for (let i = 0; i < 4; i++) mic(speech());
    for (let i = 0; i < PAUSE; i++) mic(quiet());
  };
  return { session, deps, events, say, finish: () => finishSpeaking() };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('withTimeLimit', () => {
  it('gives up on a recogniser that never answers, throws its worker away, and works again after', async () => {
    vi.useFakeTimers();
    let stalled = true;
    const inner: SttEngine = {
      load: vi.fn(async () => ({ device: 'wasm' as const, ms: 1 })),
      transcribe: vi.fn(() => (stalled ? never<string>() : Promise.resolve('hello'))),
      dispose: vi.fn(),
    };
    const engine = withTimeLimit(inner, () => 20_000);
    const first = engine.transcribe(new Float32Array(16_000));
    const caught = first.catch(error => error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(((await caught) as Error).message).toBe(STT_STALLED);
    expect(inner.dispose).toHaveBeenCalledTimes(1);
    stalled = false;
    await expect(engine.transcribe(new Float32Array(16_000))).resolves.toBe('hello');
  });
});

describe('a voice turn that never comes back', () => {
  it('is given up on after the limit, says so, and the next words get a new turn', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stt: SttEngine = {
      load: vi.fn(async () => ({ device: 'wasm' as const, ms: 1 })),
      transcribe: vi.fn(async () => 'what is on my calendar'),
      dispose: vi.fn(),
    };
    let calls = 0;
    const t = setup(stt, () =>
      ++calls === 1 ? never<EconomyTurnReply>() : Promise.resolve({ said: 'Two meetings.' }),
    );
    await t.session.start();
    t.say();
    await vi.waitFor(() => expect(t.deps.ask).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(TURN_LIMIT_MS);
    await vi.waitFor(() => expect(t.deps.speak).toHaveBeenCalledWith(TURN_TOO_LONG, OPTIONS.economy.tts));
    t.finish();
    await vi.advanceTimersByTimeAsync(0);
    t.say();
    await vi.waitFor(() => expect(t.deps.ask).toHaveBeenCalledTimes(2));
    t.session.stop();
  });
});

describe('ending a conversation with a stuck transcription', () => {
  it('throws the stuck recogniser away, so the next conversation gets a fresh one', async () => {
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const stt: SttEngine = {
      load: vi.fn(async () => ({ device: 'wasm' as const, ms: 1 })),
      transcribe: vi.fn(() => never<string>()),
      dispose: vi.fn(),
    };
    const t = setup(stt, async () => ({ said: '' }));
    await t.session.start();
    t.say();
    await vi.waitFor(() => expect(stt.transcribe).toHaveBeenCalled());
    now += 9_000;
    t.session.stop();
    expect(stt.dispose).toHaveBeenCalledTimes(1);
    expect(t.deps.releaseStt).toHaveBeenCalled();
  });

  it('keeps a healthy recogniser that was only a moment into an utterance', async () => {
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const stt: SttEngine = {
      load: vi.fn(async () => ({ device: 'wasm' as const, ms: 1 })),
      transcribe: vi.fn(() => never<string>()),
      dispose: vi.fn(),
    };
    const t = setup(stt, async () => ({ said: '' }));
    await t.session.start();
    t.say();
    await vi.waitFor(() => expect(stt.transcribe).toHaveBeenCalled());
    now += 1_000;
    t.session.stop();
    expect(stt.dispose).not.toHaveBeenCalled();
  });
});
