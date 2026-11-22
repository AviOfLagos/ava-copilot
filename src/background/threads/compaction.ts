import { generatePlainText } from '../llm/generate';
import { systemMessage, userMessage } from '../llm/messages';
import type { ChatModel, ModelMessage } from '../llm/types';
import type { AgentContext } from '../agent/types';
import { Actors, ExecutionState } from '../agent/event/types';
import { createLogger } from '../log';
import { SUMMARY_INSTRUCTIONS } from './memory';

const logger = createLogger('Compaction');

// Past this share of the model's input budget, older steps of a running task are summarized (was 0.6: a long run
// carried up to 77,000 tokens of history on every step before anything was summarized, issue #132)
export const COMPACT_AT = 0.35;
// Not worth a model call to summarize less than this (about the size of a few extracted pages), so a run that sits
// above the line because of its fixed prompt does not summarize on every step
export const MIN_COMPACT_TOKENS = 1500;
// Messages at the end of the history that always stay verbatim
export const KEEP_RECENT_MESSAGES = 12;
const MAX_PART_CHARS = 2000;

/**
 * Writes model messages as text for the summarizer.
 */
export function describeMessages(messages: ModelMessage[]): string {
  const textOf = (content: unknown): string => {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map(part => {
          if (part && typeof part === 'object' && 'text' in part) return String(part.text);
          if (part && typeof part === 'object' && 'input' in part) return JSON.stringify(part.input);
          if (part && typeof part === 'object' && 'output' in part) return JSON.stringify(part.output);
          return '';
        })
        .join(' ');
    }
    return '';
  };
  return messages
    .map(message => {
      const text = textOf(message.content).replace(/\s+/g, ' ').trim();
      return `${message.role}: ${text.length > MAX_PART_CHARS ? `${text.slice(0, MAX_PART_CHARS)}…` : text}`;
    })
    .join('\n');
}

/**
 * Summarizes the older steps of a running task once its history passes 35% of the input budget,
 * so a long task never hits the limit. The full record of the task stays in the thread's messages.
 *
 * @returns true when the history was compacted
 */
export async function compactIfNeeded(context: AgentContext, summarizer: ChatModel): Promise<boolean> {
  const manager = context.messageManager;
  // First the cheap step, with no model call: old long action results shrink to a line each
  manager.clearOldActionResults(KEEP_RECENT_MESSAGES);
  if (manager.totalTokens() <= manager.maxInputTokens() * COMPACT_AT) {
    return false;
  }
  const plan = manager.compactableMessages(KEEP_RECENT_MESSAGES);
  if (!plan || describeMessages(plan.messages).length / 4 < MIN_COMPACT_TOKENS) {
    return false;
  }

  try {
    const summary = await generatePlainText({
      chatModel: summarizer,
      messages: [systemMessage(SUMMARY_INSTRUCTIONS), userMessage(describeMessages(plan.messages))],
      abortSignal: context.controller.signal,
    });
    manager.compactHistory(summary.trim(), plan.cut);
    await context.emitEvent(
      Actors.SYSTEM,
      ExecutionState.ACT_NOTICE,
      'Summarized earlier steps to keep the task within the model limit.',
    );
    return true;
  } catch (error) {
    // Without a summary the history is left as it is; the old trimming still applies at the hard limit
    logger.warning('Could not summarize the task history', error);
    return false;
  }
}
