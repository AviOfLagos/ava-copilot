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

  it('closes in the end on a hum that got louder than the old floor, instead of staying open forever', () => {
    const gate = new SpeechGate({ sampleRate: RATE, hangoverMs: 700 });
    for (let i = 0; i < 20; i++) gate.push(chunk(false));
    // A fan comes on: a steady level well above the quiet room's threshold
    const hum = new Float32Array(RATE / 10).fill(0.05);
    expect(gate.push(hum).send.length).toBeGreaterThan(0);
    let ended = false;
    let at = 0;
    for (; at < 100 && !ended; at++) ended = gate.push(hum).ended;
    expect(ended).toBe(true);
    // Within a few seconds, and it stays closed on the same hum
    expect(at).toBeLessThan(60);
    let sent = 0;
    for (let i = 0; i < 30; i++) sent += gate.push(hum).send.length;
    expect(sent).toBe(0);
    // Real speech over the hum still opens it
    expect(gate.push(chunk(true)).send.length).toBeGreaterThan(0);
  });

  it("does not open on the copilot's echo while it plays, but opens for the user talking over it", () => {
    const gate = new SpeechGate({ sampleRate: RATE });
    for (let i = 0; i < 20; i++) gate.push(chunk(false));
    // Echo: louder than the quiet threshold, quieter than the playback one
    const echo = new Float32Array(RATE / 10).fill(0.025);
    expect(gate.threshold(true)).toBeGreaterThan(gate.threshold(false));
    for (let i = 0; i < 10; i++) expect(gate.push(echo, { playing: true }).send).toEqual([]);
    expect(gate.speaking).toBe(false);
    // The same level with nothing playing is speech
    expect(gate.push(echo).send.length).toBeGreaterThan(0);
  });

  it('needs loud speech to last a moment before opening over playback, and keeps its start', () => {
    const gate = new SpeechGate({ sampleRate: RATE, playbackHoldMs: 300 });
    for (let i = 0; i < 20; i++) gate.push(chunk(false));
    // A short loud burst (a clatter, an echo peak) does not open it
    expect(gate.push(chunk(true), { playing: true }).send).toEqual([]);
    gate.push(chunk(false), { playing: true });
    expect(gate.speaking).toBe(false);
    // Speech that keeps going does, with the first words that were held back
    expect(gate.push(chunk(true), { playing: true }).send).toEqual([]);
    expect(gate.push(chunk(true), { playing: true }).send).toEqual([]);
    const open = gate.push(chunk(true), { playing: true });
    expect(gate.speaking).toBe(true);
    expect(open.send.length).toBeGreaterThanOrEqual(3);
  });

  it('closes quietly on reset, without reporting an end', () => {
    const gate = new SpeechGate({ sampleRate: RATE });
    gate.push(chunk(true));
    expect(gate.speaking).toBe(true);
    gate.reset();
    expect(gate.speaking).toBe(false);
    expect(gate.push(chunk(false))).toEqual({ send: [], ended: false });
  });
});
