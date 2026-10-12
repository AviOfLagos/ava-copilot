import { RETRY_POLICIES, toAppError, withRetry } from '@extension/shared';
import type { RetryPolicy } from '@extension/shared';
import { breakerFor, saveBreakers } from './breakers';

// A provider that has not answered in this long is treated as down for this try
export const REQUEST_TIMEOUT_MS = 10_000;

export interface FetchJsonOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  // Stops the call, e.g. when the job running it is cancelled
  signal?: AbortSignal;
  timeoutMs?: number;
  // Reads are retried on network errors, timeouts, rate limits and outages; false sends once
  retry?: boolean;
  // Stand-ins for tests
  fetch?: typeof fetch;
  retryPolicy?: Partial<RetryPolicy>;
}

/**
 * Fetches JSON from a provider: a timeout per try, retries with back-off for failures that waiting can fix,
 * and a circuit breaker per host. Failures come out as AppError (status, Retry-After, kind); their messages
 * never quote the response, which could echo a key.
 */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const host = new URL(url).host;
  const breaker = await breakerFor(host);
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);

  const once = async (): Promise<T> => {
    const signals = [AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)];
    if (options.signal) signals.push(options.signal);
    const response = await fetchFn(url, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.any(signals),
    });
    if (!response.ok) {
      throw toAppError({
        status: response.status,
        headers: response.headers,
        message: `${host} answered ${response.status}.`,
      });
    }
    return (await response.json()) as T;
  };

  try {
    return await breaker.call(() =>
      options.retry === false
        ? once()
        : withRetry(once, { ...RETRY_POLICIES.connectorRead, signal: options.signal, ...options.retryPolicy }),
    );
  } finally {
    await saveBreakers();
  }
}
