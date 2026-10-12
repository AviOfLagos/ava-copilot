import { describe, expect, it } from 'vitest';
import { toSpeakableText } from '../markdown';

describe('toSpeakableText', () => {
  it('drops heading marks', () => {
    expect(toSpeakableText('# Title\n\nBody text.')).toBe('Title\nBody text.');
  });

  it('drops bullet and numbered list markers', () => {
    expect(toSpeakableText('- one\n- two\n\n1. first\n2. second')).toBe('one\ntwo\nfirst\nsecond');
  });

  it('keeps a link label and drops its address', () => {
    expect(toSpeakableText('See [the docs](https://example.com/path) for more.')).toBe('See the docs for more.');
  });

  it('keeps inline code text and drops the backticks', () => {
    expect(toSpeakableText('Run `npm install` first.')).toBe('Run npm install first.');
  });

  it('drops a fenced code block entirely', () => {
    expect(toSpeakableText('Before\n```js\nconst x = 1;\n```\nAfter')).toBe('Before\nAfter');
  });

  it('drops bold, italic and strikethrough marks', () => {
    expect(toSpeakableText('**bold** and _italic_ and ~~gone~~.')).toBe('bold and italic and gone.');
  });

  it('drops an image entirely', () => {
    expect(toSpeakableText('Look: ![a cat](cat.png) nice.')).toBe('Look: nice.');
  });

  it('drops blockquote and horizontal rule marks', () => {
    expect(toSpeakableText('> quoted\n\n---\n\nmore')).toBe('quoted\nmore');
  });

  it('turns a table into paused text and drops the separator row', () => {
    expect(toSpeakableText('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(', a , b ,\n, 1 , 2 ,');
  });

  it('removes emoji without touching other text', () => {
    expect(toSpeakableText('Great job! 🎉👍')).toBe('Great job!');
  });

  it('keeps non-Latin text such as Chinese untouched', () => {
    expect(toSpeakableText('# 早安\n\n今天天氣很好。')).toBe('早安\n今天天氣很好。');
  });

  it('returns an empty string for markdown that speaks nothing', () => {
    expect(toSpeakableText('```\ncode only\n```')).toBe('');
  });
});
