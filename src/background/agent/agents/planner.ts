import { BaseAgent, type BaseAgentOptions, type ExtraAgentOptions } from './base';
import { createLogger } from '@src/background/log';
import { z } from 'zod';
import type { AgentOutput } from '../types';
import { isTextPart, userMessage } from '@src/background/llm/messages';
import { Actors, ExecutionState } from '../event/types';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  isAbortedError,
  isAuthenticationError,
  isBadRequestError,
  isForbiddenError,
  LLM_FORBIDDEN_ERROR_MESSAGE,
  RequestCancelledError,
} from './errors';
import { filterExternalContent } from '../messages/utils';
import { getApiCallErrorDetails } from '@src/background/llm/errors';
import { t } from '@extension/i18n';
const logger = createLogger('PlannerAgent');

// Models replying in text may omit a field the prompt lets be empty, or send a list (e.g. next_steps) as an array.
// Unlike .default(), preprocess keeps them required strings in the JSON schema sent to the model.
const textField = z.preprocess(
  value =>
    Array.isArray(value)
      ? value.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n')
      : (value ?? ''),
  z.string(),
);

// Models may send a boolean as the string 'true' or 'false'. Preprocessing keeps it a plain boolean in the
// JSON schema, since some providers fail on type arrays such as ["boolean", "string"]
const booleanField = z.preprocess(value => {
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return value;
}, z.boolean());

// Define Zod schema for planner output
export const plannerOutputSchema = z.object({
  observation: textField,
  challenges: textField,
  done: booleanField,
  next_steps: textField,
  final_answer: textField,
  reasoning: textField,
  web_task: booleanField,
});

export type PlannerOutput = z.infer<typeof plannerOutputSchema>;

// What some models write in a field they leave empty: "None", "null", "N/A"
const PLACEHOLDER_ANSWER = /^(?:none|null|nil|undefined|n\/?a|empty|no answer)?$/i;

/** Whether a final answer has nothing in it for the user: empty, or a placeholder for "nothing". */
export function isEmptyAnswer(text: string): boolean {
  return PLACEHOLDER_ANSWER.test(text.trim().replace(/^["'`*_\s]+|["'`*_.!\s]+$/g, ''));
}

// Said to the model once when it finished with nothing to say
const EMPTY_ANSWER_NUDGE =
  'Your "final_answer" was empty or a placeholder such as "None". The user reads final_answer and nothing else. Write your reply to their latest message there now: a greeting gets a greeting, a question an answer, and when you cannot do something, say so and why.';

export class PlannerAgent extends BaseAgent<typeof plannerOutputSchema, PlannerOutput> {
  constructor(options: BaseAgentOptions, extraOptions?: Partial<ExtraAgentOptions>) {
    super(plannerOutputSchema, options, { ...extraOptions, id: 'planner' });
  }

  async execute(): Promise<AgentOutput<PlannerOutput>> {
    try {
      this.context.emitEvent(Actors.PLANNER, ExecutionState.STEP_START, 'Planning...');
      // get all messages from the message manager, state message should be the last one
      const messages = this.context.messageManager.getMessages();
      // Use full message history except the first one
      const plannerMessages = [this.prompt.getSystemMessage(), ...messages.slice(1)];

      // Remove images from last message if vision is not enabled for planner but vision is enabled
      if (!this.context.options.useVisionForPlanner && this.context.options.useVision) {
        const lastStateMessage = plannerMessages[plannerMessages.length - 1];
        let newMsg = '';

        if (typeof lastStateMessage.content === 'string') {
          newMsg = lastStateMessage.content;
        } else {
          for (const part of lastStateMessage.content) {
            if (isTextPart(part)) {
              newMsg += part.text;
            }
            // Skip image file parts
          }
        }

        plannerMessages[plannerMessages.length - 1] = userMessage(newMsg);
      }

      let modelOutput = await this.invoke(plannerMessages);
      if (!modelOutput) {
        throw new Error('Failed to validate planner output');
      }
      // Finished with nothing to say ("None" from a small model): ask once more before giving up on it
      if (modelOutput.done && isEmptyAnswer(modelOutput.final_answer)) {
        logger.warning('Planner finished with an empty answer, asking again');
        const retry = await this.invoke([...plannerMessages, userMessage(EMPTY_ANSWER_NUDGE)]).catch(error => {
          if (isAbortedError(error)) throw error;
          logger.warning('Asking again for an answer failed', error);
          return null;
        });
        if (retry && !(retry.done && isEmptyAnswer(retry.final_answer))) modelOutput = retry;
      }

      // clean the model output
      const observation = filterExternalContent(modelOutput.observation);
      // Never an empty or "None" answer: the user hears that it was lost and can say it again
      const cleanedAnswer = filterExternalContent(modelOutput.final_answer);
      const final_answer = modelOutput.done && isEmptyAnswer(cleanedAnswer) ? t('exec_emptyAnswer') : cleanedAnswer;
      const next_steps = filterExternalContent(modelOutput.next_steps);
      const challenges = filterExternalContent(modelOutput.challenges);
      const reasoning = filterExternalContent(modelOutput.reasoning);

      const cleanedPlan: PlannerOutput = {
        ...modelOutput,
        observation,
        challenges,
        reasoning,
        final_answer,
        next_steps,
      };

      // If task is done, emit the final answer; otherwise emit next steps
      const eventMessage = cleanedPlan.done ? cleanedPlan.final_answer : cleanedPlan.next_steps;
      this.context.emitEvent(Actors.PLANNER, ExecutionState.STEP_OK, eventMessage);
      logger.info('Planner output', JSON.stringify(cleanedPlan, null, 2));

      return {
        id: this.id,
        result: cleanedPlan,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Check if this is an authentication error
      if (isAuthenticationError(error)) {
        throw new ChatModelAuthError(errorMessage, error);
      } else if (isBadRequestError(error)) {
        throw new ChatModelBadRequestError(errorMessage, error);
      } else if (isAbortedError(error)) {
        throw new RequestCancelledError(errorMessage);
      } else if (isForbiddenError(error)) {
        throw new ChatModelForbiddenError(LLM_FORBIDDEN_ERROR_MESSAGE, error);
      }

      const details = getApiCallErrorDetails(error);
      if (details) {
        logger.error(`Planning failed: ${errorMessage}`, JSON.stringify(details, null, 2));
      } else {
        logger.error(`Planning failed: ${errorMessage}`);
      }
      this.context.emitEvent(Actors.PLANNER, ExecutionState.STEP_FAIL, `Planning failed: ${errorMessage}`);
      return {
        id: this.id,
        error: errorMessage,
      };
    }
  }
}
