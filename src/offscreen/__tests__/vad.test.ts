import { describe, expect, it } from 'vitest';
import { level, SpeechGate } from '../vad';

const RATE = 16000;
// 100 ms chunks: silence, or a tone loud enough to be speech
const chunk = (loud: boolean) => {
  const samples = new Float32Array(RATE / 10);
  if (loud) for (let i = 0; i < samples.length; i++) samples[i] = 0.2 * Math.sin((i / RATE) * 2 * Math.PI * 220);
  return samples;
};

describe('SpeechGate', () => {
  it('sends nothing in silence, then speech with what came just before it, then says when it ended', () => {
    const gate = new SpeechGate({ sampleRate: RATE, prerollMs: 300, hangoverMs: 500 });
    for (let i = 0; i < 20; i++) expect(gate.push(chunk(false)).send).toEqual([]);

    const start = gate.push(chunk(true));
    // Three chunks of lead-in plus the first loud one
    expect(start.send).toHaveLength(4);
    expect(gate.speaking).toBe(true);

    // A short pause between words still passes
    expect(gate.push(chunk(false)).send).toHaveLength(1);
    expect(gate.push(chunk(true)).send).toHaveLength(1);

    let ended = false;
    for (let i = 0; i < 10 && !ended; i++) ended = gate.push(chunk(false)).ended;
    expect(ended).toBe(true);
    expect(gate.speaking).toBe(false);
    expect(gate.push(chunk(false)).send).toEqual([]);
  });

  it('does not count a steady hum as speech', () => {
    const gate = new SpeechGate({ sampleRate: RATE });
    const hum = new Float32Array(RATE / 10).fill(0.008);
    let sent = 0;
    for (let i = 0; i < 50; i++) sent += gate.push(hum).send.length;
    expect(sent).toBe(0);
    expect(level(hum)).toBeCloseTo(0.008, 3);
  });

  it('opens at once for audio known to be speech', () => {
    const gate = new SpeechGate({ sampleRate: RATE });
    gate.force();
    expect(gate.push(chunk(false)).send).toHaveLength(1);
  });
});
