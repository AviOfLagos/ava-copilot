import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EconomyTurnReply, EconomyTurnRequest } from '../../../background/voice/engines/protocol';
import type { VoiceEvents } from '../../voice';
import { LULL_MS } from '../addressed';
import type { SpeakerLabel } from '../addressed';
import { EconomySession } from '../economy';
import type { EconomyDeps, EconomyOptions } from '../economy';
import type { SttEngine } from '../engines';

/**
 * When the economy conversation takes a turn, fed synthetic microphone frames: a quarter second of a tone is a
 * quarter second of speech, its amplitude how near the speaker is.
 */

const CHUNK = 4096;
const NEAR = 0.2;
// A radio across the room: loud enough to open the speech gate, far quieter than the user
const FAR = 0.03;
const tone = (amplitude: number) => Float32Array.from({ length: CHUNK }, (_, i) => amplitude * Math.sin(i / 3));
const quiet = () => new Float32Array(CHUNK);
// Chunks of quiet: a breath between words (under the 1.2 s hangover), and the end of an utterance (past it; its last
// chunk already counts toward the extra second words that stop mid-clause wait for)
const BREATH = 3;
const PAUSE = 5;

const OPTIONS: EconomyOptions = {
  mode: 'economy',
  instructions: 'You are Ava Copilot.',
  tools: [],
  economy: {
    stt: { engine: 'moonshine', model: 'moonshine-tiny', webgpu: false },
    tts: { engine: 'kitten', voice: 'Bella', rate: 1 },
  },
  assistantName: 'Ava',
};

// The session's clock: it starts at 0 and moves only with the audio fed in (and when a test jumps it), so no
// test depends on how fast the machine runs
let clock = 0;
afterEach(() => {
  vi.restoreAllMocks();
  clock = 0;
});

function setup(whoSpoke?: (audio: Float32Array) => Promise<SpeakerLabel>) {
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  let onChunk: (samples: Float32Array) => void = () => {};
  const mic = (samples: Float32Array) => {
    clock += (samples.length / 16_000) * 1000;
    onChunk(samples);
  };
  const words: string[] = [];
  const stt: SttEngine = {
    load: vi.fn(async () => ({ device: 'wasm' as const, ms: 1 })),
    transcribe: vi.fn(async () => words.shift() ?? ''),
    dispose: vi.fn(),
  };
  let finishSpeaking: () => void = () => {};
  const deps = {
    openMic: vi.fn(async (chunks: (samples: Float32Array) => void) => {
      onChunk = chunks;
      return () => {};
    }),
    loadStt: vi.fn(async () => stt),
    releaseStt: vi.fn(),
    speak: vi.fn(() => new Promise<void>(resolve => (finishSpeaking = resolve))),
    stopSpeaking: vi.fn(() => finishSpeaking()),
    warmVoice: vi.fn(async () => {}),
    ask: vi.fn(async (request: EconomyTurnRequest): Promise<EconomyTurnReply> => ({ said: `Re: ${request.heard}` })),
    ...(whoSpoke ? { whoSpoke } : {}),
  } satisfies EconomyDeps;
  const events = { onTurn: vi.fn(), onTool: vi.fn(), onStatus: vi.fn(), onUsage: vi.fn() } satisfies VoiceEvents;
  const session = new EconomySession(OPTIONS, events, deps);
  const silence = (chunks: number) => {
    for (let i = 0; i < chunks; i++) mic(quiet());
  };
  /** Speech the recogniser will write as `text`, then `pause` chunks of quiet; resolves once it is written down. */
  const say = async (text: string, { pause = PAUSE, amplitude = NEAR, chunks = 6 } = {}) => {
    words.push(text);
    const before = (stt.transcribe as ReturnType<typeof vi.fn>).mock.calls.length;
    for (let i = 0; i < chunks; i++) mic(tone(amplitude));
    silence(pause);
    await vi.waitFor(() => expect(stt.transcribe).toHaveBeenCalledTimes(before + 1));
    // The words reach the session a moment after the recogniser is called
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  return {
    session,
    deps,
    stt,
    say,
    silence,
    mic: (samples: Float32Array) => mic(samples),
    finish: () => finishSpeaking(),
  };
}

const asked = (t: ReturnType<typeof setup>) => t.deps.ask.mock.calls.map(call => call[0].heard);

describe('end of turn', () => {
  it('keeps a breath inside a sentence in one utterance, written down once', async () => {
    const t = setup();
    await t.session.start();
    t.mic(tone(NEAR));
    t.mic(tone(NEAR));
    t.silence(BREATH);
    await t.say('what is on my calendar today');
    await vi.waitFor(() => expect(t.deps.ask).toHaveBeenCalledTimes(1));
    expect(t.stt.transcribe).toHaveBeenCalledTimes(1);
    expect((t.stt.transcribe as ReturnType<typeof vi.fn>).mock.calls[0][0].length).toBeGreaterThanOrEqual(8 * CHUNK);
  });

  it("makes one turn of the fragments one of Avi's sentences was cut into (issue #24)", async () => {
    const t = setup();
    await t.session.start();
    // Each fragment ends mid-clause and the next starts within the wait: none of them is a turn on its own
    await t.say("So he's always on the code of the symbol like");
    t.silence(2);
    await t.say("I will say I'm always looking, I'm");
    t.silence(1);
    await t.say("So that's");
    expect(t.deps.ask).not.toHaveBeenCalled();
    await t.say("That's probably the end");
    await vi.waitFor(() => expect(t.deps.ask).toHaveBeenCalledTimes(1));
    expect(asked(t)).toEqual([
      "So he's always on the code of the symbol like I will say I'm always looking, I'm So that's That's probably the end",
    ]);
  });

  it('waits a second longer after words that stop mid-clause, then takes them as the turn', async () => {
    const t = setup();
    await t.session.start();
    await t.say('I was going to ask about the');
    t.silence(2);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(t.deps.ask).not.toHaveBeenCalled();
    t.silence(1);
    await vi.waitFor(() => expect(asked(t)).toEqual(['I was going to ask about the']));
  });

  it('answers a finished sentence once the pause is past the hangover, without the extra wait', async () => {
    const t = setup();
    await t.session.start();
    await t.say('book a table for two');
    await vi.waitFor(() => expect(asked(t)).toEqual(['book a table for two']));
  });

  it('holds a finished fragment while the user is talking again, and joins what follows', async () => {
    const t = setup();
    await t.session.start();
    t.stt.transcribe = vi.fn(
      () => new Promise<string>(resolve => setTimeout(() => resolve('Open my inbox.'), 30)),
    ) as SttEngine['transcribe'];
    // The words are still being written down when the user goes on
    for (let i = 0; i < 6; i++) t.mic(tone(NEAR));
    t.silence(PAUSE);
    t.mic(tone(NEAR));
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(t.deps.ask).not.toHaveBeenCalled();
    t.stt.transcribe = vi.fn(async () => 'and archive the newsletters') as SttEngine['transcribe'];
    for (let i = 0; i < 5; i++) t.mic(tone(NEAR));
    t.silence(PAUSE);
    await vi.waitFor(() => expect(asked(t)).toEqual(['Open my inbox. and archive the newsletters']));
  });
});

describe('a fresh document', () => {
  it('hears the first words at once, though its clock is still near 0 (no echo tail before the copilot spoke)', async () => {
    const t = setup();
    await t.session.start();
    // A single quarter second of speech: over the copilot's voice it would not open the gate
    await t.say('stop', { chunks: 1 });
    await vi.waitFor(() => expect(asked(t)).toEqual(['stop']));
  });
});

describe('words not meant for the copilot', () => {
  it('after a lull, ignores a radio and answers the user calling Ava by name (issue #24)', async () => {
    const t = setup();
    await t.session.start();
    await t.say('hello');
    await vi.waitFor(() => expect(t.deps.speak).toHaveBeenCalledTimes(1));
    t.finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    // Past the echo tail of her voice
    clock += 400;
    clock += LULL_MS + 1_000;
    await t.say("It's eternal. It's a lot of an amazing building.");
    await t.say('Surprising.');
    await t.say('Oh, nice day.');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(asked(t)).toEqual(['hello']);
    await t.say('Ava, what time is it?');
    await vi.waitFor(() => expect(asked(t)).toEqual(['hello', 'Ava, what time is it?']));
  });

  it('in a conversation going on, ignores a far voice and answers the near one', async () => {
    const t = setup();
    await t.session.start();
    await t.say('what is the weather');
    await vi.waitFor(() => expect(t.deps.speak).toHaveBeenCalledTimes(1));
    t.finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    // Past the echo tail of her voice
    clock += 400;
    await t.say('Oh, nice day.', { amplitude: FAR });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(asked(t)).toEqual(['what is the weather']);
    await t.say('and tomorrow?');
    await vi.waitFor(() => expect(asked(t)).toEqual(['what is the weather', 'and tomorrow?']));
  });

  it('answers soon after the copilot spoke without the name, however long the user was quiet before', async () => {
    const t = setup();
    await t.session.start();
    clock += LULL_MS + 1_000;
    t.session.say('"Inbox" is done.');
    await vi.waitFor(() => expect(t.deps.speak).toHaveBeenCalledTimes(1));
    t.finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    // Past the echo tail of her voice
    clock += 400;
    await t.say('great, what did it find?');
    await vi.waitFor(() => expect(asked(t)).toContain('great, what did it find?'));
  });

  it('leaves a seam for voiceprints: a voice that is not the user needs the name', async () => {
    const labels: SpeakerLabel[] = ['media', 'other'];
    const t = setup(async () => labels.shift() ?? 'me');
    await t.session.start();
    await t.say('breaking news tonight');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(t.deps.ask).not.toHaveBeenCalled();
    await t.say('Ava, turn that off');
    await vi.waitFor(() => expect(asked(t)).toEqual(['Ava, turn that off']));
  });
});
