import type { MessageActor, ReadAloudMode, ThreadRecord } from '@extension/storage';
import { isRemoteChat } from '../gate/origins';

export interface AutoSpeakInput {
  readAloud: ReadAloudMode;
  threadOrigin: ThreadRecord['origin'];
  // The actor of the thread's last message once its run settled
  lastMessageActor: MessageActor | undefined;
  // The Gemini Live voice session announces things itself; nothing else may speak while it runs
  voiceRunning: boolean;
  lastSpokenMessageId: string | null;
  candidateMessageId: string | undefined;
}

/**
 * Whether a thread's answer should be read aloud on its own, once a run settles to idle: never while
 * the Live conversation is going, only a planner's final words count as an answer, and the same
 * answer is never read twice (a run can settle more than once if its status is touched again).
 */
export function shouldAutoSpeak(input: AutoSpeakInput): boolean {
  if (input.readAloud === 'off') return false;
  // A chat from WhatsApp answers on WhatsApp: nothing is read aloud to an empty room
  if (isRemoteChat({ origin: input.threadOrigin })) return false;
  if (input.readAloud === 'voice' && input.threadOrigin !== 'voice') return false;
  if (input.voiceRunning) return false;
  if (input.lastMessageActor !== 'planner') return false;
  if (!input.candidateMessageId) return false;
  if (input.candidateMessageId === input.lastSpokenMessageId) return false;
  return true;
}
