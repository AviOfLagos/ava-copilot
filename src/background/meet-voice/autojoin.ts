import type { MeetStatus } from '@src/shared/lib/protocol/companion';
import { isInOrJoining } from './state';
import type { MeetAutoJoin } from './state';

/**
 * When the user starts notes in a Google Meet call: whether Ava comes in by herself, asks first, or stays out. She
 * only ever joins a call the user is in (their own call tab is on it), never a second call, and never with no
 * browser to run her in. Signed out, "Always" asks instead: joining as a guest would only fail at the lobby.
 */

export type AutoJoinDecision = 'join' | 'ask' | 'none';

export interface AutoJoinInput {
  setting: MeetAutoJoin;
  paired: boolean;
  // The notes are recording a Google Meet call
  isMeetCall: boolean;
  // The user's own tab is still on that call
  userInCall: boolean;
  status: MeetStatus | null;
}

export function decideAutoJoin(input: AutoJoinInput): AutoJoinDecision {
  if (input.setting === 'never' || !input.paired || !input.isMeetCall || !input.userInCall) return 'none';
  if (isInOrJoining(input.status) || input.status?.state === 'signing_in') return 'none';
  if (input.status && !input.status.browserFound) return 'none';
  if (input.setting === 'always' && input.status?.signedIn !== false) return 'join';
  return 'ask';
}

export const OFFER_NOTIFICATION_PREFIX = 'meetvoice-offer:';
