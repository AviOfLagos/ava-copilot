import { describe, expect, it } from 'vitest';
import { rulesMayAnswer } from '../origins';

describe('rulesMayAnswer', () => {
  it('lets a rule answer for the user at the computer', () => {
    expect(rulesMayAnswer({ origin: 'user' })).toBe(true);
    expect(rulesMayAnswer({ origin: 'voice' })).toBe(true);
    expect(rulesMayAnswer({})).toBe(true);
  });

  it('never lets one answer for a tainted run, whoever started it', () => {
    for (const origin of ['user', 'voice', 'agent', 'workflow', 'brief', 'whatsapp'] as const) {
      expect(rulesMayAnswer({ origin, tainted: true })).toBe(false);
    }
  });

  it('fails closed for a chat that cannot be read, and for a run whose starter did not say it is clean', () => {
    expect(rulesMayAnswer(undefined)).toBe(false);
    for (const origin of ['agent', 'workflow', 'brief', 'whatsapp'] as const) {
      expect(rulesMayAnswer({ origin })).toBe(false);
      expect(rulesMayAnswer({ origin, tainted: false })).toBe(true);
    }
  });
});
