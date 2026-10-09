import { describe, expect, it, vi } from 'vitest';

vi.mock('@extension/storage', () => ({ meetingStore: {} }));

const { describeNote, spokeEnd } = await import('../call-control');

describe('spokeEnd', () => {
  it('hears an order to end the call', () => {
    expect(spokeEnd('End the call')).toBe(true);
    expect(spokeEnd('okay end this meeting now')).toBe(true);
    expect(spokeEnd('end it for everyone')).toBe(true);
    expect(spokeEnd('close the call for everyone')).toBe(true);
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
