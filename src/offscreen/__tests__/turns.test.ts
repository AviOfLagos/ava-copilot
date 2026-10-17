import { describe, expect, it } from 'vitest';
import { REPLY_WAIT_MS, TurnTaking } from '../turns';
import { REALTIME_INPUT_CONFIG, voiceSetup } from '../voice';

describe('TurnTaking: when a notice may be said', () => {
  it('is free at the start', () => {
    expect(new TurnTaking().floorFree(0)).toBe(true);
  });

  it('holds notices while the user speaks, and for a moment after, until the model answered', () => {
    const turns = new TurnTaking();
    turns.userStarted();
    expect(turns.floorFree(100)).toBe(false);
    turns.userEnded(1000);
    // The server is about to answer: a notice now would cut the user's turn off
    expect(turns.floorFree(1100)).toBe(false);
    turns.modelStarted();
    expect(turns.floorFree(1200)).toBe(false);
    turns.modelEnded();
    expect(turns.floorFree(1300)).toBe(true);
  });

  it('frees the floor when the server never answers what it heard (noise, not speech)', () => {
    const turns = new TurnTaking();
    turns.userStarted();
    turns.userEnded(1000);
    expect(turns.floorFree(1000 + REPLY_WAIT_MS - 1)).toBe(false);
    expect(turns.floorFree(1000 + REPLY_WAIT_MS + 1)).toBe(true);
  });

  it('counts the copilot as speaking until its queued voice has played out, not at turnComplete', () => {
    const turns = new TurnTaking();
    turns.modelStarted();
    turns.playUntil(5000);
    turns.modelEnded();
    expect(turns.speaking(4000)).toBe(true);
    expect(turns.floorFree(4000)).toBe(false);
    expect(turns.playing(4999)).toBe(true);
    expect(turns.speaking(5001)).toBe(false);
    expect(turns.floorFree(5001)).toBe(true);
  });

  it('holds notices while a tool runs', () => {
    const turns = new TurnTaking();
    turns.toolStarted();
    expect(turns.floorFree(0)).toBe(false);
    turns.toolEnded();
    expect(turns.floorFree(0)).toBe(true);
  });

  it('stops the voice at once when the user talks over it, and waits for their answer', () => {
    const turns = new TurnTaking();
    turns.modelStarted();
    turns.playUntil(9000);
    turns.interrupted(2000);
    expect(turns.playing(2001)).toBe(false);
    expect(turns.floorFree(2100)).toBe(false);
  });
});

describe('the Live session setup', () => {
  it('tunes the server turn detection for a conversation', () => {
    const { setup } = voiceSetup({ model: 'gemini-live', instructions: 'Be brief.', tools: [] } as never, null);
    expect(setup.realtimeInputConfig).toEqual(REALTIME_INPUT_CONFIG);
    expect(REALTIME_INPUT_CONFIG).toEqual({
      automaticActivityDetection: {
        startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
        endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
        prefixPaddingMs: 200,
        silenceDurationMs: 600,
      },
      activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
    });
  });
});
