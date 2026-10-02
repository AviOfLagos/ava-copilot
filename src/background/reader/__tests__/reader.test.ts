import { describe, expect, it } from 'vitest';
import { describeSlice } from '../reader';

describe('describeSlice', () => {
  it('says where the slice sits and how to read on', () => {
    expect(describeSlice({ text: 'x'.repeat(100), offset: 0, total: 250 })).toBe(
      'Page text, characters 0 to 100 of 250. More text follows: call read_page_text with offset 100.',
    );
  });

  it('says when the page text ends', () => {
    expect(describeSlice({ text: 'x'.repeat(50), offset: 200, total: 250 })).toBe(
      'Page text, characters 200 to 250 of 250. This is the end of the page text.',
    );
  });

  it('reports a page with no text', () => {
    expect(describeSlice({ text: '', offset: 0, total: 0 })).toBe('The page shows no text.');
  });
});
