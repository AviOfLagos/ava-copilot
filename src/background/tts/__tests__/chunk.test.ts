import { describe, expect, it } from 'vitest';
import { chunkText } from '../chunk';

describe('chunkText', () => {
  it('returns nothing for empty text', () => {
    expect(chunkText('')).toEqual([]);
  });

  it('keeps short text as one chunk', () => {
    expect(chunkText('Hello there.', 200)).toEqual(['Hello there.']);
  });

  it('combines short sentences into one chunk while it fits', () => {
    const chunks = chunkText('One. Two. Three.', 200);
    expect(chunks).toEqual(['One. Two. Three.']);
  });

  it('starts a new chunk once the limit would be crossed', () => {
    const chunks = chunkText('Twelve chars. Twelve chars. Twelve chars.', 20);
    expect(chunks.every(chunk => chunk.length <= 20)).toBe(true);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe('Twelve chars. Twelve chars. Twelve chars.');
  });

  it('breaks a single sentence longer than the limit at a space', () => {
    const long = 'word '.repeat(20).trim(); // 99 chars, no sentence punctuation at all
    const chunks = chunkText(long, 30);
    expect(chunks.every(chunk => chunk.length <= 30)).toBe(true);
    // Every word survives, in order, nothing merged or dropped
    expect(chunks.join(' ').split(/\s+/).filter(Boolean)).toEqual(long.split(' '));
  });

  it('splits on line breaks as well as sentence ends', () => {
    // Pieces that fit in one chunk are joined with a space - a chunk is one spoken utterance, and
    // the line break between them carried no words of its own
    expect(chunkText('First line\nSecond line', 200)).toEqual(['First line Second line']);
    expect(chunkText('First line\nSecond line', 11)).toEqual(['First line', 'Second line']);
  });
});
