import { threadStore } from '@extension/storage';
import type { AgentContext } from '../agent/types';
import { rulesMayAnswer } from './origins';

/**
 * Whether a saved "Allow every time" rule may answer for this task, and whether its card may offer one. False for a
 * run that read content from outside (see `rulesMayAnswer`); the card itself shows as usual.
 */
export async function ruleMayAnswer(context: Pick<AgentContext, 'taskId'>): Promise<boolean> {
  return rulesMayAnswer(await threadStore.get(context.taskId).catch(() => undefined));
}
