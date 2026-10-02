import { APICallError, wrapLanguageModel } from 'ai';
import { t } from '@extension/i18n';
import { localDay, usageStore } from '@extension/storage';
import type { ChatModel } from '../llm/types';
import { createLogger } from '../log';
import { costOf } from './pricing';

const logger = createLogger('Usage');

// Retries after the first attempt; with the delays below the last one comes about 30 s in
export const MAX_RATE_LIMIT_RETRIES = 4;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 60_000;
// Rate limited, or the service is briefly unavailable
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// Where a task's model calls report to
export interface UsageScope {
  // The chat session the calls belong to
  sessionId: string;
  // Shows a short status line to the user, e.g. while waiting to retry
  notify: (message: string) => void;
}

/**
 * How long to wait before retrying a failed model call.
 *
 * @param error - What the call threw
 * @param attempt - How many retries have been made so far
 * @returns The delay in milliseconds, or null when the call should not be retried
 */
export function retryDelay(error: unknown, attempt: number): number | null {
  if (!APICallError.isInstance(error) || attempt >= MAX_RATE_LIMIT_RETRIES) {
    return null;
  }
  if (error.statusCode === undefined || !RETRYABLE_STATUS.has(error.statusCode)) {
    return null;
  }
  // The server's own advice wins over the backoff schedule
  const retryAfter = Number(error.responseHeaders?.['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_DELAY_MS);
  }
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * Adds one model call to the day's and the session's totals.
 */
export async function recordUsage(sessionId: string, model: string, inputTokens: number, outputTokens: number) {
  const day = localDay();
  const cost = costOf(model, inputTokens, outputTokens, day);
  await usageStore.add(sessionId, day, {
    inputTokens,
    outputTokens,
    costUsd: cost ?? 0,
    calls: 1,
    unpricedCalls: cost === null ? 1 : 0,
  });
}

/**
 * Wraps a chat model so that every call is counted, and a rate-limited call waits and retries
 * with a status line the user can see instead of failing the step.
 */
export function meterModel(chatModel: ChatModel, scope: UsageScope): ChatModel {
  if (typeof chatModel.model === 'string') {
    return chatModel;
  }

  const model = wrapLanguageModel({
    model: chatModel.model,
    middleware: {
      wrapGenerate: async ({ doGenerate, params }) => {
        for (let attempt = 0; ; attempt++) {
          try {
            const result = await doGenerate();
            try {
              await recordUsage(
                scope.sessionId,
                chatModel.modelName,
                result.usage.inputTokens.total ?? 0,
                result.usage.outputTokens.total ?? 0,
              );
            } catch (error) {
              // Losing a usage record must not fail the task
              logger.error('Failed to record usage', error);
            }
            return result;
          } catch (error) {
            const delay = retryDelay(error, attempt);
            if (delay === null) {
              if (APICallError.isInstance(error) && attempt > 0) {
                // Retries are used up here; stop the SDK from running its own on top
                throw new APICallError({ ...error, message: error.message, cause: error.cause, isRetryable: false });
              }
              throw error;
            }
            scope.notify(t('usage_rateLimited', [String(Math.ceil(delay / 1000))]));
            await sleep(delay, params.abortSignal);
          }
        }
      },
    },
  });

  return { ...chatModel, model };
}
