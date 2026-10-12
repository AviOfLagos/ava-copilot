import { describe, expect, it } from 'vitest';
import { shouldAutoSpeak } from '../decision';
import type { AutoSpeakInput } from '../decision';

const BASE: AutoSpeakInput = {
  readAloud: 'voice',
  threadOrigin: 'voice',
  lastMessageActor: 'planner',
  voiceRunning: false,
  lastSpokenMessageId: null,
  candidateMessageId: 'm2',
};

describe('shouldAutoSpeak', () => {
  it('speaks a fresh planner answer from a voice-started thread when set to "voice"', () => {
    expect(shouldAutoSpeak(BASE)).toBe(true);
  });

  it('never speaks when turned off', () => {
    expect(shouldAutoSpeak({ ...BASE, readAloud: 'off' })).toBe(false);
  });

  it('with "voice", stays quiet for a thread the user typed', () => {
    expect(shouldAutoSpeak({ ...BASE, threadOrigin: 'user' })).toBe(false);
  });

  it('with "always", speaks regardless of origin', () => {
    expect(shouldAutoSpeak({ ...BASE, readAloud: 'always', threadOrigin: 'user' })).toBe(true);
    expect(shouldAutoSpeak({ ...BASE, readAloud: 'always', threadOrigin: undefined })).toBe(true);
  });

  it('never speaks while the Gemini Live conversation is going, even with "always"', () => {
    expect(shouldAutoSpeak({ ...BASE, readAloud: 'always', voiceRunning: true })).toBe(false);
  });

  it('only a planner message counts as an answer', () => {
    expect(shouldAutoSpeak({ ...BASE, lastMessageActor: 'system' })).toBe(false);
    expect(shouldAutoSpeak({ ...BASE, lastMessageActor: undefined })).toBe(false);
  });

  it('never speaks the same answer twice', () => {
    expect(shouldAutoSpeak({ ...BASE, lastSpokenMessageId: 'm2' })).toBe(false);
    // A different message is still fair game
    expect(shouldAutoSpeak({ ...BASE, lastSpokenMessageId: 'm1' })).toBe(true);
  });

  it('has nothing to speak without a candidate message id', () => {
    expect(shouldAutoSpeak({ ...BASE, candidateMessageId: undefined })).toBe(false);
  });
});
