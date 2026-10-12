import { describe, expect, it, vi } from 'vitest';

vi.mock('@extension/i18n', () => ({ t: (key: string) => key }));

const { joinWords } = await import('../Composer');

describe('joinWords', () => {
  it('puts the dictated words after what was typed, with one space', () => {
    expect(joinWords('Note:', 'call Ada')).toBe('Note: call Ada');
    expect(joinWords('Note:  \n', '  call Ada ')).toBe('Note: call Ada');
  });

  it('is the words alone when nothing was typed, and what was typed when nothing was heard', () => {
    expect(joinWords('', 'call Ada')).toBe('call Ada');
    expect(joinWords('Note:', '   ')).toBe('Note:');
  });
});
