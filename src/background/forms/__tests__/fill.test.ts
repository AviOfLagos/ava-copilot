import { describe, expect, it, vi } from 'vitest';

vi.mock('../../gate/review', () => ({ askQuestions: vi.fn(), reviewAction: vi.fn() }));

const { describeAnswers, fieldKind, wantsTick } = await import('../fill');

describe('fieldKind', () => {
  it('tells typed, chosen and ticked fields apart', () => {
    expect(fieldKind({ tagName: 'input', attributes: { type: 'email' } })).toBe('text');
    expect(fieldKind({ tagName: 'textarea', attributes: {} })).toBe('text');
    expect(fieldKind({ tagName: 'select', attributes: {} })).toBe('select');
    expect(fieldKind({ tagName: 'input', attributes: { type: 'checkbox' } })).toBe('tick');
    expect(fieldKind({ tagName: 'div', attributes: { role: 'radio' } })).toBe('tick');
  });
});

describe('wantsTick', () => {
  it('ticks only on a yes', () => {
    expect(wantsTick('true')).toBe(true);
    expect(wantsTick(' Yes ')).toBe(true);
    expect(wantsTick('false')).toBe(false);
    expect(wantsTick('')).toBe(false);
  });
});

describe('describeAnswers', () => {
  it('pairs each question with its answer, and says which to leave empty', () => {
    const text = describeAnswers(['Date of birth?', 'Company?'], ['1 May 1990', '']);
    expect(text).toContain('- Date of birth? → 1 May 1990');
    expect(text).toContain('- Company? → (left blank: leave this field empty)');
  });
});
