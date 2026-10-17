import { describe, expect, it } from 'vitest';
import { concat, hasWords, isRequest, UtteranceCollector, voicedSamples } from '../utterances';

// What the PCM worklet hands over: about a quarter second at 16 kHz
const CHUNK = 4096;
const speech = () => Float32Array.from({ length: CHUNK }, (_, i) => 0.2 * Math.sin(i / 3));
const quiet = () => new Float32Array(CHUNK);

function feed(collector: UtteranceCollector, chunks: Float32Array[]) {
  const steps = chunks.map(chunk => collector.push(chunk));
  return {
    started: steps.filter(step => step.speechStarted).length,
    utterances: steps.map(step => step.utterance).filter((u): u is Float32Array => u !== null),
  };
}

describe('UtteranceCollector', () => {
  it('gives one utterance per stretch of speech, ending when the speaker stops', () => {
    const collector = new UtteranceCollector();
    const { started, utterances } = feed(collector, [
      quiet(),
      quiet(),
      ...Array.from({ length: 8 }, speech),
      ...Array.from({ length: 4 }, quiet),
    ]);
    expect(started).toBe(1);
    expect(utterances).toHaveLength(1);
    // The speech, a little lead-in, and the pause that ended it; never the whole silence
    expect(utterances[0].length).toBeGreaterThanOrEqual(8 * CHUNK);
    expect(utterances[0].length).toBeLessThan(13 * CHUNK);
    expect(collector.speaking).toBe(false);
  });

  it('transcribes nothing for silence, and drops a click too short to be words', () => {
    const collector = new UtteranceCollector();
    expect(feed(collector, Array.from({ length: 10 }, quiet)).utterances).toHaveLength(0);
    // A knock: 20 ms of sound, loud enough to open the gate
    const click = new Float32Array(CHUNK);
    click.fill(0.9, 0, 320);
    const { started, utterances } = feed(collector, [click, ...Array.from({ length: 4 }, quiet)]);
    expect(started).toBe(1);
    expect(utterances).toHaveLength(0);
  });

  it('counts voiced sound in 20 ms frames', () => {
    const chunk = new Float32Array(1600);
    chunk.fill(0.5, 320, 960);
    expect(voicedSamples(chunk, 320)).toBe(640);
  });

  it('cuts very long speech into pieces', () => {
    const collector = new UtteranceCollector({ maxMs: 1000 });
    const { utterances } = feed(collector, Array.from({ length: 12 }, speech));
    expect(utterances.length).toBeGreaterThanOrEqual(2);
    for (const utterance of utterances) expect(utterance.length).toBeLessThanOrEqual(1000 * 16 + CHUNK);
  });

  it('starts with what followed "Hey Ava", gate open', () => {
    const collector = new UtteranceCollector();
    collector.seed([speech(), speech()]);
    expect(collector.speaking).toBe(true);
    const { utterances } = feed(collector, [speech(), ...Array.from({ length: 4 }, quiet)]);
    expect(utterances).toHaveLength(1);
    expect(utterances[0].length).toBeGreaterThanOrEqual(3 * CHUNK);
  });
});

describe('helpers', () => {
  it('joins chunks in order', () => {
    expect(Array.from(concat([Float32Array.of(1, 2), Float32Array.of(3)]))).toEqual([1, 2, 3]);
  });

  it('tells words from what recognisers make of noise', () => {
    expect(hasWords('Hey Ava, what is on today?')).toBe(true);
    expect(hasWords('')).toBe(false);
    expect(hasWords(' . ')).toBe(false);
    expect(hasWords('[unk]')).toBe(false);
  });
});

describe('isRequest', () => {
  it('drops what recognisers make of noise', () => {
    for (const noise of ['you', 'You.', 'Thank you.', ' thanks for watching! ', 'Hmm...', '[unk]', '.', ''])
      expect(isRequest(noise)).toBe(false);
  });

  it('keeps anything the user asked, however short', () => {
    for (const asked of [
      "What's on today?",
      'Stop',
      'open gmail',
      'thank you, that is all',
      'yes',
      'Yeah.',
      'okay',
      'bye',
    ])
      expect(isRequest(asked)).toBe(true);
  });
});
