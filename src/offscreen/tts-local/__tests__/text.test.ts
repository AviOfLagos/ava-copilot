import { describe, expect, it } from 'vitest';
import {
  basicEnglishTokenize,
  ensurePunctuation,
  kokoroPhonemes,
  rms,
  splitSentences,
  styleRow,
  trimSilence,
  trimTail,
} from '../text';

describe('splitSentences', () => {
  it('splits at sentence ends and keeps the punctuation', () => {
    expect(splitSentences('Hello! This is how I sound. Ready?')).toEqual(['Hello!', 'This is how I sound.', 'Ready?']);
  });

  it('keeps a closing quote with its sentence and a last sentence with no stop', () => {
    expect(splitSentences('She said "go." Then we left')).toEqual(['She said "go."', 'Then we left']);
  });

  it('cuts a long sentence at a comma, else a space, under the limit', () => {
    const long = `${'word '.repeat(30)}and then, ${'more '.repeat(40)}end.`;
    const chunks = splitSentences(long, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(120);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' ').trim());
  });

  it('keeps the first chunk short, so speech starts sooner', () => {
    const answer = `Your next meeting is the sponsor sync with the whole team, at three in the afternoon, in the big room upstairs. Bring the deck.`;
    const chunks = splitSentences(answer);
    expect(chunks[0].length).toBeLessThanOrEqual(90);
    expect(chunks[0]).toMatch(/,$/);
    expect(chunks.join(' ')).toBe(answer);
  });

  it('drops chunks with nothing to say', () => {
    expect(splitSentences('   ')).toEqual([]);
    expect(splitSentences('... !!')).toEqual([]);
  });
});

describe('KittenTTS text', () => {
  it('ends every chunk with punctuation', () => {
    expect(ensurePunctuation('hello there')).toBe('hello there,');
    expect(ensurePunctuation('hello there.')).toBe('hello there.');
  });

  it('splits phonemes the way the Python tokenizer does', () => {
    expect(basicEnglishTokenize('həlˈoʊ! ðɪs ɪz')).toEqual(['həlˈoʊ', '!', 'ðɪs', 'ɪz']);
  });

  it('picks the style row for the token count, capped at the last row', () => {
    const voice = Float32Array.from({ length: 12 }, (_, i) => i);
    expect(Array.from(styleRow(voice, 4, 1))).toEqual([4, 5, 6, 7]);
    expect(Array.from(styleRow(voice, 4, 99))).toEqual([8, 9, 10, 11]);
  });
});

describe('Kokoro phonemes', () => {
  it("applies Kokoro's own fixes", () => {
    expect(kokoroPhonemes('rˈɛd ʲes')).toBe('ɹˈɛd jes');
    expect(kokoroPhonemes('nˈaɪnti')).toBe('nˈaɪndi');
  });
});

describe('audio clean-up', () => {
  it("cuts KittenTTS's tail and the quiet at both ends, with a short margin", () => {
    const clip = new Float32Array(24_000);
    clip.fill(0.5, 6000, 12_000);
    const trimmed = trimSilence(clip, 24_000, 0.01, 100);
    // 6000 samples of sound plus 100 ms (2400 samples) kept on each side
    expect(trimmed.length).toBe(6000 + 2 * 2400);
    expect(trimSilence(new Float32Array(100), 24_000)).toHaveLength(0);
    expect(trimTail(new Float32Array(8000))).toHaveLength(3000);
  });

  it('measures loudness', () => {
    expect(rms(new Float32Array(10))).toBe(0);
    expect(rms(Float32Array.of(0.5, -0.5))).toBeCloseTo(0.5);
  });
});
