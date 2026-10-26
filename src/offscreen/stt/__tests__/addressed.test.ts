import { describe, expect, it } from 'vitest';
import {
  Addressee,
  callWords,
  FAINT_RATIO,
  LULL_MS,
  namesAssistant,
  OPENING_LULL_MS,
  soundsUnfinished,
} from '../addressed';
import type { HeardFragment } from '../addressed';

const AVA = callWords('Ava');
const heard = (text: string, at: number, level = 0.14, speaker: HeardFragment['speaker'] = 'unknown') => ({
  text,
  level,
  startedAt: at,
  speaker,
});

describe('soundsUnfinished', () => {
  // The fragments one sentence of Avi's was cut into on 2026-10-26 (issue #24)
  it.each([
    "So he's always on the code of the symbol like",
    "I will say I'm always looking, I'm",
    "So that's",
    'I was going to the',
    'and then,',
    'Ava.',
    'Hey Ava',
  ])('waits for the rest after "%s"', text => {
    expect(soundsUnfinished(text, AVA)).toBe(true);
  });

  it.each([
    "That's probably the end",
    'what is on my calendar today',
    'book a table for two',
    'Can you turn it on?',
    'yes',
    'no',
    'I think so',
    'thanks',
  ])('takes "%s" as finished', text => {
    expect(soundsUnfinished(text, AVA)).toBe(false);
  });
});

describe('namesAssistant', () => {
  it('hears Ava by name, and what recognisers make of it', () => {
    expect(namesAssistant('Ava, what is next?', AVA)).toBe(true);
    expect(namesAssistant('hey eva open my mail', AVA)).toBe(true);
    expect(namesAssistant("what's Ava's plan", AVA)).toBe(true);
    expect(namesAssistant("It's a lot of an amazing building.", AVA)).toBe(false);
    // Not a word inside another word
    expect(namesAssistant('lavatory', AVA)).toBe(false);
  });

  it("uses the user's own name for the copilot", () => {
    const names = callWords('Nova Prime');
    expect(names).toEqual(['nova']);
    expect(namesAssistant('Nova, read that', names)).toBe(true);
    expect(namesAssistant('Ava, read that', names)).toBe(false);
  });
});

describe('Addressee', () => {
  it('answers anything while the conversation is going on', () => {
    const addressee = new Addressee(AVA, 0);
    expect(addressee.judge([heard('what time is it', 1_000)], 2_000)).toEqual({ ok: true });
    addressee.exchanged(5_000);
    expect(addressee.judge([heard('and tomorrow', 20_000)], 21_000)).toEqual({ ok: true });
  });

  it('after a lull, answers only words that use the name', () => {
    const addressee = new Addressee(AVA, 0);
    expect(addressee.judge([heard('hello', 1_000)], 1_500).ok).toBe(true);
    const later = 1_500 + LULL_MS + 1;
    // The radio at 12:56 (issue #24)
    expect(addressee.judge([heard("It's eternal. It's a lot of an amazing building.", later)], later)).toEqual({
      ok: false,
      reason: 'lull',
    });
    expect(addressee.judge([heard('Surprising.', later + 3_000)], later + 3_500).ok).toBe(false);
    // Called by name: the conversation is back on, and the next words need no name
    expect(addressee.judge([heard('Ava, what was that?', later + 9_000)], later + 10_000).ok).toBe(true);
    expect(addressee.judge([heard('and the other one', later + 15_000)], later + 16_000).ok).toBe(true);
  });

  it('gives the opening longer: the user started the conversation and may take a while to speak', () => {
    const addressee = new Addressee(AVA, 0);
    expect(addressee.judge([heard('so, my calendar', LULL_MS + 5_000)], LULL_MS + 6_000).ok).toBe(true);
    const fresh = new Addressee(AVA, 0);
    expect(fresh.judge([heard('so, my calendar', OPENING_LULL_MS + 1)], OPENING_LULL_MS + 2).ok).toBe(false);
  });

  it('counts the lull to when the speech started, so a long sentence is not taken for one after a lull', () => {
    const addressee = new Addressee(AVA, 0);
    addressee.judge([heard('hi', 100)], 200);
    // Started 20 s after the last exchange and went on for 15 s
    expect(addressee.judge([heard('a long story', 20_200)], 35_200).ok).toBe(true);
  });

  it("drops a voice much quieter than the user's own unless it uses the name", () => {
    const addressee = new Addressee(AVA, 0);
    for (let i = 0; i < 3; i++) expect(addressee.judge([heard('near', i * 1000, 0.14)], i * 1000 + 500).ok).toBe(true);
    const faint = 0.14 * FAINT_RATIO * 0.8;
    expect(addressee.judge([heard('Oh, nice day.', 5_000, faint)], 5_500)).toEqual({ ok: false, reason: 'faint' });
    expect(addressee.judge([heard('Ava, over here', 6_000, faint)], 6_500).ok).toBe(true);
    // A name called from across the room does not lower what counts as the user's level
    expect(addressee.faintBelow()).toBeCloseTo(0.14 * FAINT_RATIO);
    // A turn the user spoke in part near the microphone is theirs
    expect(addressee.judge([heard('so', 7_000, faint), heard('this one', 7_500, 0.12)], 8_000).ok).toBe(true);
  });

  it('needs the name from a voice a voiceprint says is not the user', () => {
    const addressee = new Addressee(AVA, 0);
    expect(addressee.judge([heard('breaking news', 1_000, 0.14, 'media')], 1_500)).toEqual({
      ok: false,
      reason: 'other',
    });
    expect(addressee.judge([heard('Ava, hi', 2_000, 0.14, 'other')], 2_500).ok).toBe(true);
    expect(addressee.judge([heard('next please', 3_000, 0.14, 'me')], 3_500).ok).toBe(true);
  });
});
