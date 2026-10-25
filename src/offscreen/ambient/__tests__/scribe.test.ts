import { describe, expect, it, vi } from 'vitest';
import { AmbientScribe } from '../scribe';
import type { ScribeEvent } from '../scribe';

// What the PCM worklet hands over: about a quarter second at 16 kHz
const CHUNK = 4096;
const speech = () => Float32Array.from({ length: CHUNK }, (_, i) => 0.2 * Math.sin(i / 3));
const quiet = () => new Float32Array(CHUNK);
const sentence = () => [quiet(), quiet(), ...Array.from({ length: 8 }, speech), ...Array.from({ length: 6 }, quiet)];

function scribe(texts: string[]) {
  const events: ScribeEvent[] = [];
  let clock = 1_000_000;
  const transcribe = vi.fn(async () => texts.shift() ?? '');
  const s = new AmbientScribe({
    transcribe,
    emit: event => events.push(event),
    now: () => (clock += 256),
  });
  const say = async () => {
    for (const chunk of sentence()) s.push(chunk);
    await s.settled();
  };
  return { s, events, transcribe, say };
}

describe('AmbientScribe', () => {
  it('writes down each stretch of speech as one utterance with its times', async () => {
    const { events, transcribe, say } = scribe(['We ship on Friday.', 'Sounds good.']);
    await say();
    await say();
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(events.map(event => event.type === 'ambient_utterance' && event.text)).toEqual([
      'We ship on Friday.',
      'Sounds good.',
    ]);
    const first = events[0] as Extract<ScribeEvent, { type: 'ambient_utterance' }>;
    expect(first.endedAt).toBeGreaterThan(first.startedAt);
  });

  it('never transcribes silence and drops noise turned into filler words', async () => {
    const { s, events, transcribe, say } = scribe(['Thank you.']);
    for (let i = 0; i < 20; i++) s.push(quiet());
    await s.settled();
    expect(transcribe).not.toHaveBeenCalled();
    await say();
    expect(events).toEqual([]);
  });

  it('off the record, only "back on the record" gets out, and nothing else said', async () => {
    const { s, events, say } = scribe(['the salary numbers are', 'back on the record']);
    s.configure({ offRecord: true });
    await say();
    await say();
    expect(events).toEqual([{ type: 'ambient_back_on_record' }]);
  });

  it('hears nothing while paused for any reason, and goes on once every reason is gone', async () => {
    const { s, events, transcribe, say } = scribe(['during the call', 'after the call']);
    s.pause('voice');
    s.pause('dictation');
    await say();
    s.resume('voice');
    await say();
    expect(transcribe).not.toHaveBeenCalled();
    s.resume('dictation');
    await say();
    expect(events.map(event => event.type === 'ambient_utterance' && event.text)).toEqual(['during the call']);
  });

  it('a recogniser that fails loses that utterance only', async () => {
    const events: ScribeEvent[] = [];
    const transcribe = vi.fn().mockRejectedValueOnce(new Error('worker gone')).mockResolvedValueOnce('still here');
    const s = new AmbientScribe({ transcribe, emit: event => events.push(event) });
    for (const chunk of [...sentence(), ...sentence()]) s.push(chunk);
    await s.settled();
    expect(events).toEqual([
      { type: 'ambient_error', error: 'worker gone' },
      expect.objectContaining({ type: 'ambient_utterance', text: 'still here' }),
    ]);
  });
});
