import { describe, expect, it, vi } from 'vitest';

vi.mock('@extension/storage', () => ({ meetingStore: {} }));

const { describeNote, spokeEnd, spokeJoin, spokeLeave } = await import('../call-control');

describe('spokeEnd', () => {
  it('hears an order to end the call', () => {
    expect(spokeEnd('End the call')).toBe(true);
    expect(spokeEnd('okay end this meeting now')).toBe(true);
    expect(spokeEnd('end it for everyone')).toBe(true);
    expect(spokeEnd('close the call for everyone')).toBe(true);
    expect(spokeEnd('yes', 'end the meeting')).toBe(true);
  });

  it('needs an order to end, said now: not talk about the call, a no, or an old turn', () => {
    expect(spokeEnd('the meeting is useful for everyone')).toBe(false);
    expect(spokeEnd('keep the call going for everyone')).toBe(false);
    expect(spokeEnd("don't end the call")).toBe(false);
    expect(spokeEnd('what time is it', 'end the call')).toBe(false);
    expect(spokeEnd('yes, read the agenda', 'end the call')).toBe(false);
  });

  it('does not take leaving, or talk about an end, as ending it', () => {
    expect(spokeEnd('leave the call')).toBe(false);
    expect(spokeEnd('what did we decide at the end of the meeting')).toBe(false);
    expect(spokeEnd('I will attend the call later')).toBe(false);
    expect(spokeEnd('yes')).toBe(false);
  });
});

describe('describeNote', () => {
  it('reads out the gist, decisions and action points', () => {
    const text = describeNote({
      title: 'Stage 2 sync',
      tldr: ['Launch moves to Friday'],
      decisions: ['Ship without dark mode'],
      actionItems: [{ owner: 'Avi', task: 'Email the client', due: null }],
      openQuestions: [],
      participants: [],
    });
    expect(text).toContain('Stage 2 sync');
    expect(text).toContain('- Ship without dark mode');
    expect(text).toContain('- Email the client (Avi)');
  });
});

describe('spokeLeave and spokeJoin', () => {
  it('hear leaving and joining only when asked', () => {
    expect(spokeLeave('leave the call')).toBe(true);
    expect(spokeLeave('hang up')).toBe(true);
    expect(spokeLeave('end the call')).toBe(true);
    expect(spokeLeave('summarise the call')).toBe(false);
    expect(spokeLeave("don't leave the call yet")).toBe(false);
    expect(spokeJoin('join my next meeting')).toBe(true);
    expect(spokeJoin('when is my next meeting')).toBe(false);
  });
});
