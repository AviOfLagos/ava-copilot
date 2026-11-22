import { threadStore } from '@extension/storage';
import { UNTRUSTED_CONTENT_TAG_START } from '../agent/messages/utils';
import type { AgentContext } from '../agent/types';
import { createLogger } from '../log';
import { rulesMayAnswer } from './origins';

/**
 * Whether a saved "Allow every time" rule may answer for this task, and whether its card may offer one. False for a
 * run that read content from outside (see `rulesMayAnswer`); the card itself shows as usual.
 */
export async function ruleMayAnswer(context: Pick<AgentContext, 'taskId'>): Promise<boolean> {
  const thread = await threadStore.get(context.taskId).catch(() => undefined);
  if (!rulesMayAnswer(thread)) return false;
  // A task a voice conversation started (speaking in a call) inherits what that conversation read
  if (thread?.voiceThreadId) {
    return rulesMayAnswer(await threadStore.get(thread.voiceThreadId).catch(() => undefined));
  }
  return true;
}

const logger = createLogger('Taint');

// A user at the computer reads pages all the time: that alone does not taint the chat. Anything else does.
const AT_COMPUTER = new Set(['user', 'voice']);

/**
 * Marks a chat as having read content from outside (a message, an email, a transcript, a connector's answer), for
 * good: from then on no saved "Allow every time" rule answers for it. Cheap when already marked. Never throws.
 */
export async function markTainted(threadId: string, reason: string): Promise<void> {
  try {
    const thread = await threadStore.get(threadId);
    if (!thread || thread.tainted === true) return;
    await threadStore.update(threadId, { tainted: true });
    logger.info(`Chat marked as having read outside content: ${reason}`);
  } catch (error) {
    logger.warning('Could not mark a chat as tainted', error);
  }
}

/**
 * A page was shown to the model. An agent's, a routine's, the brief's or a WhatsApp chat is tainted by it; the user's
 * own chat at the computer is not (it works on pages the user opened, and they watch it).
 */
export async function markPageRead(threadId: string): Promise<void> {
  const thread = await threadStore.get(threadId).catch(() => undefined);
  if (!thread || thread.tainted === true || (thread.origin && AT_COMPUTER.has(thread.origin))) return;
  if (!thread.origin) return;
  await markTainted(threadId, 'page');
}

/** Whether a tool's answer carries content marked as untrusted (see agent/messages/utils). */
export const carriesOutsideContent = (text: string | undefined | null): boolean =>
  !!text && text.includes(UNTRUSTED_CONTENT_TAG_START);
