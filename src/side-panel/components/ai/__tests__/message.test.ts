import { describe, expect, it } from 'vitest';
import { safeUrl } from '../message';

describe('safeUrl', () => {
  it('keeps web and mail links', () => {
    expect(safeUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeUrl('mailto:ada@example.com')).toBe('mailto:ada@example.com');
  });

  it('drops scripts, data and anything else', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('');
    expect(safeUrl('data:text/html,<b>x</b>')).toBe('');
    expect(safeUrl('chrome-extension://abc/options.html')).toBe('');
  });
});
