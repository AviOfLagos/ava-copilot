import { describe, expect, it } from 'vitest';
import { BUILTIN_PERSONALITIES, DEFAULT_PERSONALITY_ID } from '../builtins';
import {
  checkPersonality,
  duplicatePersonality,
  EMPTY_PERSONALITIES,
  matchPersonality,
  normalizePersonalities,
  personalityRateOf,
  personalityVoiceFor,
  resolvePersonality,
  switchesWorkspace,
  withActive,
} from '../personalities';
import type { PersonalitiesState, Personality } from '../types';

const custom = (changes: Partial<Personality> = {}): Personality => ({
  id: 'custom-sales',
  name: 'Sales coach',
  description: 'Pushes for the close.',
  icon: '📈',
  instructions: 'Ask what the next step with the customer is.',
  voices: {},
  rate: 0,
  ...changes,
});

const state = (changes: Partial<PersonalitiesState> = {}): PersonalitiesState => ({
  ...EMPTY_PERSONALITIES,
  custom: [custom()],
  ...changes,
});

describe('checkPersonality', () => {
  it('cleans a valid personality', () => {
    const check = checkPersonality({ name: '  Sales   coach ', instructions: '  Be bold.\r\n  ', icon: '' });
    expect(check).toEqual({
      ok: true,
      personality: expect.objectContaining({ name: 'Sales coach', instructions: 'Be bold.', icon: '💬', rate: 0 }),
    });
  });

  it('lists every problem', () => {
    const check = checkPersonality({
      name: 'x'.repeat(41),
      description: 'd'.repeat(161),
      icon: '🙂🙂🙂🙂🙂',
      instructions: 'i'.repeat(2001),
      rate: 3,
    });
    expect(check).toEqual({
      ok: false,
      problems: ['nameTooLong', 'descriptionTooLong', 'iconTooLong', 'instructionsTooLong', 'rate'],
    });
    expect(checkPersonality({ name: ' ', instructions: '' })).toEqual({
      ok: false,
      problems: ['nameEmpty', 'instructionsEmpty'],
    });
  });

  it('accepts exactly 2,000 characters of instructions', () => {
    expect(checkPersonality({ name: 'Long', instructions: 'i'.repeat(2000) }).ok).toBe(true);
  });
});

describe('the built-ins', () => {
  it('ship six, the default first and empty, every other one with instructions under the cap', () => {
    expect(BUILTIN_PERSONALITIES.map(item => item.id)).toEqual([
      'default',
      'engineer',
      'accountant',
      'legal',
      'auntie',
      'operator',
    ]);
    expect(BUILTIN_PERSONALITIES[0].instructions).toBe('');
    for (const item of BUILTIN_PERSONALITIES.slice(1)) {
      expect(checkPersonality(item).ok, item.id).toBe(true);
    }
  });

  it('keep the legal disclaimer and never let the operator claim to be Bezos', () => {
    const byId = (id: string) => BUILTIN_PERSONALITIES.find(item => item.id === id)!;
    expect(byId('legal').instructions).toContain('Not legal advice; check with a lawyer for anything binding.');
    expect(byId('operator').instructions).toContain('never claim to be him');
    expect(byId('operator').description.toLowerCase()).toContain('inspired by');
    expect(byId('auntie').instructions).toContain('Never insult');
  });
});

describe('resolvePersonality', () => {
  it('uses the workspace default, then the active one, then the default', () => {
    const s = state({ activeId: 'accountant', workspaceDefaults: { finance: 'custom-sales' } });
    expect(resolvePersonality(s, 'finance').id).toBe('custom-sales');
    expect(resolvePersonality(s, 'other').id).toBe('accountant');
    expect(resolvePersonality(s, null).id).toBe('accountant');
    expect(resolvePersonality(state({ activeId: 'gone' }), null).id).toBe(DEFAULT_PERSONALITY_ID);
  });

  it('ignores a workspace default that no longer exists', () => {
    const s = state({ activeId: 'legal', workspaceDefaults: { finance: 'gone' } });
    expect(resolvePersonality(s, 'finance').id).toBe('legal');
  });
});

describe('withActive', () => {
  it('changes the active one outside a workspace with its own default', () => {
    const s = state({ workspaceDefaults: { finance: 'accountant' } });
    expect(withActive(s, 'engineer', null).activeId).toBe('engineer');
    expect(withActive(s, 'engineer', 'sales').activeId).toBe('engineer');
    expect(switchesWorkspace(s, 'sales')).toBe(false);
  });

  it("changes the workspace's default inside one that has it, so the switch takes effect there", () => {
    const s = state({ workspaceDefaults: { finance: 'accountant' } });
    const next = withActive(s, 'auntie', 'finance');
    expect(next.workspaceDefaults.finance).toBe('auntie');
    expect(next.activeId).toBe(DEFAULT_PERSONALITY_ID);
    expect(resolvePersonality(next, 'finance').id).toBe('auntie');
    expect(switchesWorkspace(s, 'finance')).toBe(true);
  });

  it('refuses an unknown id', () => {
    const s = state();
    expect(withActive(s, 'nope', null)).toBe(s);
  });
});

describe('matchPersonality', () => {
  const s = state();
  it.each([
    ['accountant', 'accountant'],
    ['the accountant', 'accountant'],
    ['switch to the strict auntie', 'auntie'],
    ['Bezos', 'operator'],
    ['back to normal', 'default'],
    ['cracked engineer', 'engineer'],
    ['my sales coach', 'custom-sales'],
    ['Legal eye', 'legal'],
  ])('finds "%s"', (request, id) => {
    expect(matchPersonality(s, request)?.id).toBe(id);
  });

  it('finds nothing for unknown words or nothing at all', () => {
    expect(matchPersonality(s, 'a pirate')).toBeUndefined();
    expect(matchPersonality(s, '  ')).toBeUndefined();
  });
});

describe('duplicatePersonality', () => {
  it('makes an editable copy with a new id', () => {
    const copy = duplicatePersonality(BUILTIN_PERSONALITIES[2]);
    expect(copy.id).toMatch(/^custom-/);
    expect(copy.name).toBe('Accountant (copy)');
    expect(copy.builtIn).toBeUndefined();
    expect(copy.instructions).toBe(BUILTIN_PERSONALITIES[2].instructions);
    // The default's copy gets a line to start from, so it passes the check
    expect(checkPersonality(duplicatePersonality(BUILTIN_PERSONALITIES[0])).ok).toBe(true);
  });
});

describe('normalizePersonalities', () => {
  it('fills a missing state and drops references to deleted personalities', () => {
    expect(normalizePersonalities(undefined)).toEqual(EMPTY_PERSONALITIES);
    const s = normalizePersonalities({
      custom: [],
      activeId: 'custom-sales',
      workspaceDefaults: { a: 'custom-sales' },
    });
    expect(s.activeId).toBe(DEFAULT_PERSONALITY_ID);
    expect(s.workspaceDefaults).toEqual({});
  });

  it('never lets stored data mark a custom personality as built-in', () => {
    const s = normalizePersonalities({ custom: [custom({ builtIn: true })] });
    expect(s.custom[0].builtIn).toBeUndefined();
  });
});

describe('voice and pace', () => {
  it('uses a local voice only on its own engine, a system voice only on the system engine', () => {
    expect(personalityVoiceFor('kokoro', { voice: 'af_bella' })).toBe('af_bella');
    expect(personalityVoiceFor('kitten', { voice: 'af_bella' })).toBeUndefined();
    expect(personalityVoiceFor('system', { voice: 'af_bella' })).toBeUndefined();
    expect(personalityVoiceFor('system', { voice: 'Samantha' })).toBe('Samantha');
    expect(personalityVoiceFor('kitten', { voice: 'Samantha' })).toBeUndefined();
    expect(personalityVoiceFor('gemini', { voice: 'Samantha' })).toBeUndefined();
    expect(personalityVoiceFor('system', { voice: '' })).toBeUndefined();
  });

  it('keeps the settings pace for 0 or out of range', () => {
    expect(personalityRateOf({ rate: 1.25 })).toBe(1.25);
    expect(personalityRateOf({ rate: 0 })).toBeUndefined();
    expect(personalityRateOf({ rate: 5 })).toBeUndefined();
    expect(personalityRateOf(null)).toBeUndefined();
  });
});
