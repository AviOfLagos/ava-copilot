import { APICallError, LoadAPIKeyError, RetryError } from 'ai';
import { toAppError } from '@extension/shared';
import type { FallbackReason } from './types';

/**
 * Return the last underlying error of a `RetryError`, or the error itself.
 */
export function unwrapError(error: unknown): unknown {
  if (RetryError.isInstance(error) && error.lastError !== undefined) {
    return error.lastError;
  }
  return error;
}

/**
 * HTTP status code of a failed provider API call, if the error came from one.
 */
export function getApiCallStatusCode(error: unknown): number | undefined {
  const unwrapped = unwrapError(error);
  return APICallError.isInstance(unwrapped) ? unwrapped.statusCode : undefined;
}

/**
 * Response body of a failed provider API call, if the error came from one.
 */
export function getApiCallResponseBody(error: unknown): string | undefined {
  const unwrapped = unwrapError(error);
  return APICallError.isInstance(unwrapped) ? unwrapped.responseBody : undefined;
}

/**
 * Status code, error data and response body of a failed provider API call, for logging.
 * OpenRouter reports upstream failures in a 200 response, so only `data` holds the upstream provider and its error.
 */
export function getApiCallErrorDetails(
  error: unknown,
): { statusCode?: number; data?: unknown; responseBody?: string } | undefined {
  const unwrapped = unwrapError(error);
  if (!APICallError.isInstance(unwrapped)) {
    return undefined;
  }
  return { statusCode: unwrapped.statusCode, data: unwrapped.data, responseBody: unwrapped.responseBody };
}

export function isMissingApiKeyError(error: unknown): boolean {
  return LoadAPIKeyError.isInstance(unwrapError(error));
}

// A 429 that is a spent quota rather than a short burst (Gemini, OpenAI, Anthropic wording)
const QUOTA_TEXT = /quota|insufficient_quota|billing|credit balance|RESOURCE_EXHAUSTED/i;

/**
 * Whether a failed model call may be tried again on a local model, and why: a bad or missing key, a spent quota,
 * a rate limit the usage meter already waited out, an outage, the network or a timeout. Never a cancel, a request
 * the provider rejected because of what we sent (400, 413, 422), a budget, or a reply that could not be parsed.
 */
export function fallbackReason(error: unknown): FallbackReason | null {
  const cause = unwrapError(error);
  if (isMissingApiKeyError(cause)) return 'auth';
  if (APICallError.isInstance(cause) && cause.statusCode === undefined) {
    // The SDK's "Cannot connect to API": no response at all
    return 'network';
  }
  const appError = toAppError(cause);
  switch (appError.kind) {
    case 'rate_limit': {
      const text = `${appError.message} ${APICallError.isInstance(cause) ? (cause.responseBody ?? '') : ''}`;
      return QUOTA_TEXT.test(text) ? 'quota' : 'rate_limit';
    }
    case 'auth':
    case 'forbidden':
    case 'quota':
    case 'unavailable':
    case 'network':
    case 'timeout':
      return appError.kind;
    default:
      return null;
  }
}
