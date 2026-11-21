import { describe, expect, it } from 'vitest';
import { doubleMetaphone } from '../metaphone';
import { englishWordCount, isEnglishWord } from '../words';

const primary = (word: string) => doubleMetaphone(word).primary;

describe('Double Metaphone', () => {
  it.each([
    ['Smith', 'SM0'],
    ['Schmidt', 'XMT'],
    ['Knight', 'NT'],
    ['Xavier', 'SF'],
    ['Catherine', 'K0RN'],
    ['Michael', 'MKL'],
    ['Jose', 'HS'],
    ['Caesar', 'SSR'],
    ['Wright', 'RT'],
    ['Philip', 'FLP'],
    ['Laugh', 'LF'],
    ['Thomas', 'TMS'],
    ['Edge', 'AJ'],
  ])('%s sounds like %s', (word, code) => {
    expect(primary(word)).toBe(code);
  });

  it('gives Illum, Elum, Ellum and Ilium the same code', () => {
    const codes = ['Illum', 'Elum', 'Ellum', 'Ilium', 'Ellam'].map(primary);
    expect(new Set(codes).size).toBe(1);
    expect(codes[0]).toBe('ALM');
  });

  it('ignores case, accents and punctuation', () => {
    expect(primary('ÉLUM')).toBe(primary('elum'));
    expect(primary("Qu'illon")).toBe(primary('Quillon'));
    expect(primary('')).toBe('');
  });
});

describe('the English word list', () => {
  it('holds about 80,000 words', () => {
    expect(englishWordCount()).toBeGreaterThan(75_000);
    expect(englishWordCount()).toBeLessThan(95_000);
  });

  it('knows ordinary words, and not misheard names', () => {
    for (const word of ['ilium', 'studio', 'anatomy', 'quill', 'colour', 'color', 'Ellen']) {
      expect(isEnglishWord(word)).toBe(true);
    }
    for (const word of ['illum', 'elum', 'ellum', 'zorvane', 'quillon']) expect(isEnglishWord(word)).toBe(false);
  });
});
