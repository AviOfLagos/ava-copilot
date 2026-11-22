import { describe, expect, it } from 'vitest';
import { rulesMayAnswer } from '../origins';

type Origin = 'user' | 'voice' | 'agent' | 'workflow' | 'brief' | 'whatsapp';
const KINDS = ['send', 'publish', 'submit', 'tool', 'team', 'workflow', 'delete', 'purchase', 'permission'] as const;

describe('rulesMayAnswer', () => {
  // Own chats at the computer: clean, any kind; tainted, only a form submit
  it.each(['user', 'voice'] as Origin[])(
    '%s chat: a rule answers while clean, and after outside content only for submit',
    origin => {
      for (const kind of KINDS) {
        expect(rulesMayAnswer({ origin }, kind)).toBe(true);
        expect(rulesMayAnswer({ origin, tainted: false }, kind)).toBe(true);
        expect(rulesMayAnswer({ origin, tainted: true }, kind)).toBe(kind === 'submit');
      }
      // No kind given, tainted: closed
      expect(rulesMayAnswer({ origin, tainted: true })).toBe(false);
      expect(rulesMayAnswer({ origin })).toBe(true);
    },
  );

  it("a chat with no origin counts as the user's", () => {
    expect(rulesMayAnswer({}, 'send')).toBe(true);
    expect(rulesMayAnswer({ tainted: true }, 'send')).toBe(false);
  });

  // Agent, routine, brief, WhatsApp: only when the starter said clean, and never once tainted
  it.each(['agent', 'workflow', 'brief', 'whatsapp'] as Origin[])('%s chat: no rule unless known clean', origin => {
    for (const kind of KINDS) {
      expect(rulesMayAnswer({ origin }, kind)).toBe(false);
      expect(rulesMayAnswer({ origin, tainted: true }, kind)).toBe(false);
      expect(rulesMayAnswer({ origin, tainted: false }, kind)).toBe(true);
    }
  });

  it('fails closed for a chat that cannot be read', () => {
    for (const kind of KINDS) expect(rulesMayAnswer(undefined, kind)).toBe(false);
  });
});
