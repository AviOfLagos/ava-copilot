import { APICallError, wrapLanguageModel } from 'ai';
import { t } from '@extension/i18n';
import {
  db as defaultDb,
  getProviderTypeByProviderId,
  llmProviderStore,
  localDay,
  usageStore,
} from '@extension/storage';
import type { AviCopilotDb, ModelCatalogEntry, ModelRole, UsageEvent } from '@extension/storage';
import type { ChatModel } from '../llm/types';
import { whileRetrying } from '../retry/status';
import type { RetryReporter } from '../retry/status';
import { createLogger } from '../log';
import { priceCall } from './pricing';

const logger = createLogger('Usage');

// Retries after the first attempt; with the delays below the last one comes about 30 s in
export const MAX_RATE_LIMIT_RETRIES = 4;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 60_000;
// Rate limited, or the service is briefly unavailable
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Who a model call is for, so usage adds up per agent, routine, run and workspace. */
export interface UsageAttribution {
  agentId?: string | null;
  workflowId?: string | null;
  runId?: string | null;
  workspaceId?: string | null;
  // The role the model was picked for; chats are 'thread'
  role?: ModelRole | 'thread';
  // Light work routed to a local model, and the cloud model it replaced (to count what was saved)
  light?: boolean;
  savedAgainst?: { providerId: string; model: string } | null;
}

// Where a task's model calls report to
export interface UsageScope extends UsageAttribution {
  // The chat session the calls belong to
  sessionId: string;
  // Shows a short status line to the user, e.g. while waiting to retry
  notify: (message: string) => void;
  // Shows a countdown while a call waits to retry; absent where nothing shows it (then `notify` is used)
  status?: RetryReporter;
}

/** A recorded call's details: the provider (for its price) and who it was for. */
export interface UsageDetails extends UsageAttribution {
  providerId?: string;
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
 * Prices one call: from the provider's kind (local servers are free), Gemini's price table, or the price the
 * model registry found. Null when nobody knows the price.
 */
export async function priceOfCall(
  call: { providerId?: string; model: string; inputTokens: number; outputTokens: number; day: string },
  database: AviCopilotDb = defaultDb,
): Promise<number | null> {
  let providerType: string | undefined;
  let entry: ModelCatalogEntry | undefined;
  if (call.providerId) {
    const summary = (await llmProviderStore.getProviderSummaries())[call.providerId];
    providerType = summary?.type ?? getProviderTypeByProviderId(call.providerId);
    entry = await database.modelCatalog.get(`${call.providerId}:${call.model}`);
  }
  return priceCall({ ...call, providerType }, entry ?? null);
}

/** Adds a call to the day's and the session's totals and writes its usage event. */
async function record(
  sessionId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cost: number | null,
  details: UsageDetails,
  database: AviCopilotDb,
  at: number,
): Promise<UsageEvent> {
  const day = localDay(new Date(at));
  await usageStore.add(sessionId, day, {
    inputTokens,
    outputTokens,
    costUsd: cost ?? 0,
    calls: 1,
    unpricedCalls: cost === null ? 1 : 0,
    unpricedTokens: cost === null ? inputTokens + outputTokens : 0,
  });

  const needsThread = details.workspaceId === undefined || details.agentId === undefined;
  const thread = needsThread ? await database.threads.get(sessionId).catch(() => undefined) : undefined;
  const event: UsageEvent = {
    id: crypto.randomUUID(),
    at,
    day,
    providerId: details.providerId ?? '',
    model,
    role: details.role ?? 'thread',
    sessionId,
    agentId: details.agentId !== undefined ? details.agentId : (thread?.agentId ?? null),
    workflowId: details.workflowId ?? null,
    runId: details.runId ?? null,
    workspaceId: details.workspaceId !== undefined ? details.workspaceId : (thread?.workspaceId ?? null),
    inputTokens,
    outputTokens,
    costUsd: cost,
  };
  if (details.light) {
    event.light = true;
    event.savedUsd = details.savedAgainst
      ? await priceOfCall({ ...details.savedAgainst, inputTokens, outputTokens, day }, database).catch(() => null)
      : null;
  }
  await database.usageEvents.add(event);
  return event;
}

/**
 * Adds one model call to the day's and the session's totals, and records it as a usage event (per model,
 * agent, routine, run and workspace). A chat's workspace and agent come from its thread when not given.
 *
 * @returns The event recorded
 */
export async function recordUsage(
  sessionId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  details: UsageDetails = {},
  database: AviCopilotDb = defaultDb,
): Promise<UsageEvent> {
  const at = Date.now();
  const cost = await priceOfCall(
    { providerId: details.providerId, model, inputTokens, outputTokens, day: localDay(new Date(at)) },
    database,
  );
  return record(sessionId, model, inputTokens, outputTokens, cost, details, database, at);
}

/**
 * Records usage priced by something other than tokens, such as Live audio by the minute (voice, live
 * captions), so it shows per model, agent and workspace like every other call.
 */
export async function recordPricedUsage(
  sessionId: string,
  model: string,
  costUsd: number,
  details: UsageDetails = {},
  database: AviCopilotDb = defaultDb,
): Promise<UsageEvent> {
  return record(sessionId, model, 0, 0, costUsd, details, database, Date.now());
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
                {
                  providerId: chatModel.provider,
                  role: scope.role,
                  light: scope.light,
                  savedAgainst: scope.savedAgainst,
                  agentId: scope.agentId,
                  workflowId: scope.workflowId,
                  runId: scope.runId,
                  workspaceId: scope.workspaceId,
                },
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
            if (scope.status) {
              await whileRetrying(
                scope.status,
                { kind: 'model', until: Date.now() + delay, attempt: attempt + 1, max: MAX_RATE_LIMIT_RETRIES },
                () => sleep(delay, params.abortSignal),
              );
            } else {
              scope.notify(t('usage_rateLimited', [String(Math.ceil(delay / 1000))]));
              await sleep(delay, params.abortSignal);
            }
          }
        }
      },
    },
  });

  return { ...chatModel, model, status: scope.status };
}
