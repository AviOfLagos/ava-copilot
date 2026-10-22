import { describe, expect, it } from 'vitest';
import type { MeetStatus } from '@src/shared/lib/protocol/companion';
import { decideAutoJoin } from '../autojoin';
import type { AutoJoinInput } from '../autojoin';

const status = (changes: Partial<MeetStatus> = {}): MeetStatus => ({
  state: 'idle',
  reason: null,
  meetingCode: null,
  speaking: false,
  signedIn: true,
  browserFound: true,
  since: 1,
  ...changes,
});

const input = (changes: Partial<AutoJoinInput> = {}): AutoJoinInput => ({
  setting: 'always',
  paired: true,
  isMeetCall: true,
  userInCall: true,
  status: status(),
  ...changes,
});

describe('Ava joins the calls the user joins', () => {
  it('never by default, and never without the user in a Meet call', () => {
    expect(decideAutoJoin(input({ setting: 'never' }))).toBe('none');
    expect(decideAutoJoin(input({ userInCall: false }))).toBe('none');
    expect(decideAutoJoin(input({ isMeetCall: false }))).toBe('none');
    expect(decideAutoJoin(input({ paired: false }))).toBe('none');
  });

  it('always joins, ask asks', () => {
    expect(decideAutoJoin(input())).toBe('join');
    expect(decideAutoJoin(input({ setting: 'ask' }))).toBe('ask');
  });

  it('not while she is in or on her way into a call, or signing in', () => {
    for (const state of ['joining', 'waiting_admission', 'in_call', 'signing_in'] as const) {
      expect(decideAutoJoin(input({ status: status({ state }) }))).toBe('none');
    }
  });

  it('signed out, "always" asks instead; no browser, nothing', () => {
    expect(decideAutoJoin(input({ status: status({ signedIn: false }) }))).toBe('ask');
    expect(decideAutoJoin(input({ status: status({ browserFound: false }) }))).toBe('none');
  });
});
