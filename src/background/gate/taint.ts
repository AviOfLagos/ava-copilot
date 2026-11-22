import { threadStore } from '@extension/storage';
import type { ThreadRecord } from '@extension/storage';
import { UNTRUSTED_CONTENT_TAG_START } from '../agent/messages/utils';
import type { AgentContext } from '../agent/types';
import { createLogger } from '../log';
import { rulesMayAnswer } from './origins';

const logger = createLogger('Taint');

/**
 * Chats that read outside content in this background's lifetime. Held in memory too, so a write to the store that
 * fails, or is slow, never leaves the gates thinking the chat is clean (fail closed).
 */
const taintedNow = new Set<string>();

/** The chat as the gates must see it: marked in the store or in memory. */
export function withTaint<T extends Pick<ThreadRecord, 'id' | 'tainted'>>(thread: T): T {
  return taintedNow.has(thread.id) && thread.tainted !== true ? { ...thread, tainted: true } : thread;
}

/** For tests: forgets what this background remembers. */
export const forgetTaint = (): void => taintedNow.clear();

/**
 * Marks a chat as having read content from outside (a message, an email, a transcript, a connector's answer), for
 * good. The memory mark comes first and cannot fail; a failed write is logged and the chat still counts as tainted.
 * Pass the run's context to mark it too.
 */
export async function markTainted(
  threadId: string,
  reason: string,
  context?: Pick<AgentContext, 'tainted'>,
): Promise<void> {
  if (context) context.tainted = true;
  if (taintedNow.has(threadId)) return;
  taintedNow.add(threadId);
  try {
    const thread = await threadStore.get(threadId);
    if (!thread || thread.tainted === true) return;
    await threadStore.update(threadId, { tainted: true });
    logger.info(`Chat marked as having read outside content: ${reason}`);
  } catch (error) {
    logger.warning('Could not save that a chat read outside content; it stays marked in memory', error);
  }
}

/**
 * A page was shown to the model: the chat has read outside content, whoever started it. (Whether a rule may still
 * answer for a user's own chat is decided by kind, see `rulesMayAnswer`.)
 */
export async function markPageRead(threadId: string, context?: Pick<AgentContext, 'tainted'>): Promise<void> {
  await markTainted(threadId, 'page', context);
}

/**
 * Whether a saved "Allow every time" rule of this kind may answer for this task, and whether its card may offer
 * one. False for a run that read content from outside, by the policy in `rulesMayAnswer`; the card itself shows as
 * usual. A task a voice conversation started also answers to what that conversation read.
 */
export async function ruleMayAnswer(context: Pick<AgentContext, 'taskId'> & { tainted?: boolean }, kind?: string) {
  const thread = await threadStore.get(context.taskId).catch(() => undefined);
  const seen = thread ? withTaint(context.tainted ? { ...thread, tainted: true } : thread) : thread;
  if (!rulesMayAnswer(seen, kind)) return false;
  if (thread?.voiceThreadId) {
    const voice = await threadStore.get(thread.voiceThreadId).catch(() => undefined);
    return rulesMayAnswer(voice ? withTaint(voice) : voice, kind);
  }
  return true;
}

/**
 * Whether a tool's result brought in text written by someone else. The flag (`ActionResult.outside`) is what tools
 * set; the untrusted-content marker is a second net for a tool that wraps its text and forgot the flag.
 */
export const carriesOutsideContent = (result: { outside?: boolean; extractedContent?: string | null }): boolean =>
  result.outside === true || !!result.extractedContent?.includes(UNTRUSTED_CONTENT_TAG_START);

/** Whether a string answer (a voice tool's) carries content marked as untrusted. */
export const textCarriesOutsideContent = (text: string | undefined | null): boolean =>
  !!text && text.includes(UNTRUSTED_CONTENT_TAG_START);
