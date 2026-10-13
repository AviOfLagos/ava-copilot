import { describe, expect, it, vi } from 'vitest';
import type { EconomyTurnReply, EconomyTurnRequest } from '../../../background/voice/engines/protocol';
import type { VoiceEvents } from '../../voice';
import { EconomySession } from '../economy';
import type { EconomyDeps, EconomyOptions } from '../economy';
import type { SttEngine } from '../engines';

const CHUNK = 4096;
const speech = () => Float32Array.from({ length: CHUNK }, (_, i) => 0.2 * Math.sin(i / 3));
const quiet = () => new Float32Array(CHUNK);

const OPTIONS: EconomyOptions = {
  mode: 'economy',
  instructions: 'You are Nex Copilot.',
  tools: [{ name: 'get_status', description: 'Says which tasks are running.' }],
  economy: {
    stt: { engine: 'moonshine', model: 'moonshine-tiny', webgpu: false },
    tts: { engine: 'kitten', voice: 'Bella', rate: 1 },
  },
};

function setup(
  answer: (request: EconomyTurnRequest) => EconomyTurnReply | Promise<EconomyTurnReply>,
  options = OPTIONS,
) {
  let mic: (samples: Float32Array) => void = () => {};
  const heard: string[] = [];
  const stt: SttEngine = {
    load: vi.fn(async () => ({ device: 'wasm' as const, ms: 1 })),
    transcribe: vi.fn(async () => heard.shift() ?? ''),
    dispose: vi.fn(),
  };
  let finishSpeaking: () => void = () => {};
  const closeMic = vi.fn();
  const deps = {
    openMic: vi.fn(async (onChunk: (samples: Float32Array) => void) => {
      mic = onChunk;
      return closeMic;
    }),
    loadStt: vi.fn(async () => stt),
    releaseStt: vi.fn(),
    speak: vi.fn(() => new Promise<void>(resolve => (finishSpeaking = resolve))),
    stopSpeaking: vi.fn(() => finishSpeaking()),
    warmVoice: vi.fn(async () => {}),
    ask: vi.fn(async (request: EconomyTurnRequest) => answer(request)),
  } satisfies EconomyDeps;
  const events = {
    onTurn: vi.fn(),
    onTool: vi.fn(),
    onStatus: vi.fn(),
    onUsage: vi.fn(),
  } satisfies VoiceEvents;
  const session = new EconomySession(options, events, deps);
  /** The user says something (their words, as the recogniser will write them), then pauses. */
  const say = (words: string, chunks = 4) => {
    heard.push(words);
    for (let i = 0; i < chunks; i++) mic(speech());
    for (let i = 0; i < 4; i++) mic(quiet());
  };
  const statuses = () => events.onStatus.mock.calls.map(call => call[0]);
  return {
    session,
    deps,
    events,
    stt,
    say,
    mic: (samples: Float32Array) => mic(samples),
    statuses,
    closeMic,
    finish: () => finishSpeaking(),
  };
}

describe('EconomySession', () => {
  it('hears a question on the device, gets the answer from the background, and speaks it', async () => {
    const t = setup(() => ({ said: 'You have two meetings today.' }));
    await t.session.start();
    expect(t.deps.loadStt).toHaveBeenCalledWith(OPTIONS.economy.stt);
    expect(t.deps.warmVoice).toHaveBeenCalledWith(OPTIONS.economy.tts);
    expect(t.statuses()).toEqual(['connecting', 'listening']);

    t.say('what is on my calendar today');
    await vi.waitFor(() => expect(t.deps.speak).toHaveBeenCalled());

    expect(t.stt.transcribe).toHaveBeenCalledTimes(1);
    expect(t.deps.ask).toHaveBeenCalledWith({
      type: 'voice_engine_turn',
      heard: 'what is on my calendar today',
      history: [],
      instructions: OPTIONS.instructions,
      tools: OPTIONS.tools,
    });
    expect(t.deps.speak).toHaveBeenCalledWith('You have two meetings today.', OPTIONS.economy.tts);
    expect(t.events.onTurn).toHaveBeenCalledWith('what is on my calendar today', 'You have two meetings today.');
    expect(t.statuses().at(-1)).toBe('speaking');

    t.finish();
    await vi.waitFor(() => expect(t.statuses().at(-1)).toBe('listening'));

    // The next turn carries the one before
    t.say('and tomorrow');
    await vi.waitFor(() => expect(t.deps.ask).toHaveBeenCalledTimes(2));
    expect(t.deps.ask.mock.calls[1][0].history).toEqual([
      { heard: 'what is on my calendar today', said: 'You have two meetings today.' },
    ]);
  });

  it('stops talking at once when the user talks over the answer', async () => {
    const t = setup(() => ({ said: 'A long answer about many things.' }));
    await t.session.start();
    t.say('tell me everything');
    await vi.waitFor(() => expect(t.deps.speak).toHaveBeenCalled());

    // Under half a second of speech is not enough (a cough, an echo)
    t.mic(speech());
    expect(t.deps.stopSpeaking).not.toHaveBeenCalled();
    t.mic(speech());
    expect(t.deps.stopSpeaking).toHaveBeenCalledWith(OPTIONS.economy.tts);
    await vi.waitFor(() => expect(t.statuses().at(-1)).toBe('listening'));
  });

  it('does not speak an answer the user has already talked past', async () => {
    let release: (reply: EconomyTurnReply) => void = () => {};
    const replies = [
      new Promise<EconomyTurnReply>(resolve => (release = resolve)),
      Promise.resolve({ said: 'Okay, cancelled.' }),
    ];
    const t = setup(() => replies.shift()!);
    await t.session.start();
    t.say('book a table for two');
    await vi.waitFor(() => expect(t.deps.ask).toHaveBeenCalledTimes(1));

    // While the first answer is on its way, the user goes on
    t.say('actually never mind');
    await vi.waitFor(() => expect(t.stt.transcribe).toHaveBeenCalledTimes(2));
    release({ said: 'Which restaurant?' });

    await vi.waitFor(() => expect(t.deps.ask).toHaveBeenCalledTimes(2));
    expect(t.deps.ask.mock.calls[1][0].heard).toBe('actually never mind');
    await vi.waitFor(() => expect(t.deps.speak).toHaveBeenCalledTimes(1));
    expect(t.deps.speak).toHaveBeenCalledWith('Okay, cancelled.', OPTIONS.economy.tts);
    // Both exchanges are kept in the conversation
    expect(t.events.onTurn).toHaveBeenCalledWith('book a table for two', 'Which restaurant?');
  });

  it('passes on a notice from the browser once it is free', async () => {
    const t = setup(request => ({ said: request.notice ? 'Your inbox task is done.' : '' }));
    await t.session.start();
    t.session.say('"Inbox" is done.');
    await vi.waitFor(() => expect(t.deps.speak).toHaveBeenCalledWith('Your inbox task is done.', OPTIONS.economy.tts));
    expect(t.deps.ask.mock.calls[0][0]).toMatchObject({ notice: '"Inbox" is done.' });
    expect(t.deps.ask.mock.calls[0][0].heard).toBeUndefined();
    expect(t.events.onTurn).toHaveBeenCalledWith('', 'Your inbox task is done.');
  });

  it('says nothing more once the conversation was ended by voice', async () => {
    const t = setup(() => ({ said: '', ended: true }));
    await t.session.start();
    t.say("goodbye, that's all");
    await vi.waitFor(() => expect(t.deps.ask).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(t.deps.speak).not.toHaveBeenCalled();
  });

  it('says sorry and shows why when a turn fails', async () => {
    const t = setup(() => ({ said: '', error: 'No model can do "fast" work yet.' }));
    await t.session.start();
    t.say('hello');
    await vi.waitFor(() =>
      expect(t.deps.speak).toHaveBeenCalledWith('Sorry, I could not answer that.', OPTIONS.economy.tts),
    );
    expect(t.events.onStatus).toHaveBeenCalledWith('listening', 'No model can do "fast" work yet.');
  });

  it('starts with what followed "Hey Ava"', async () => {
    const t = setup(() => ({ said: 'Nothing today.' }));
    const session = new EconomySession({ ...OPTIONS, preroll: [speech(), speech(), speech()] }, t.events, t.deps);
    await session.start();
    for (let i = 0; i < 4; i++) t.mic(quiet());
    await vi.waitFor(() => expect(t.stt.transcribe).toHaveBeenCalledTimes(1));
    expect((t.stt.transcribe as ReturnType<typeof vi.fn>).mock.calls[0][0].length).toBeGreaterThanOrEqual(3 * CHUNK);
  });

  it('gives the recogniser back when ended while it loads', async () => {
    const t = setup(() => ({ said: '' }));
    let loaded: (engine: SttEngine) => void = () => {};
    t.deps.loadStt.mockImplementation(() => new Promise<SttEngine>(resolve => (loaded = resolve)));
    const starting = t.session.start();
    t.session.stop();
    loaded(t.stt);
    await starting;
    expect(t.deps.releaseStt).toHaveBeenCalledTimes(1);
    expect(t.deps.openMic).not.toHaveBeenCalled();
  });

  it('ends cleanly: microphone closed, recogniser released, status off, nothing more said', async () => {
    const t = setup(() => ({ said: 'Too late.' }));
    await t.session.start();
    t.session.stop();
    expect(t.closeMic).toHaveBeenCalled();
    expect(t.deps.releaseStt).toHaveBeenCalledTimes(1);
    expect(t.statuses().at(-1)).toBe('off');
    t.say('are you there');
    t.session.say('A notice.');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(t.deps.ask).not.toHaveBeenCalled();
  });
});
