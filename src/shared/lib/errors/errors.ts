/**
 * One way to describe what went wrong, everywhere: model calls, fetches, MCP servers, the Mac companion.
 * The kind decides what happens next (retry, ask the user to sign in, stop); the message is a plain
 * sentence fit for the user. The cause stays for logs, which must never include secrets.
 */

export type AppErrorKind =
  | 'network'
  | 'timeout'
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'forbidden'
  | 'invalid'
  | 'not_found'
  | 'unavailable'
  | 'cancelled'
  | 'budget'
  // A side effect was cut off mid-call: whether it happened is not known, so it is never retried by itself
  | 'unknown_outcome'
  | 'unknown';

const RETRYABLE: ReadonlySet<AppErrorKind> = new Set(['network', 'timeout', 'rate_limit', 'unavailable']);

export class AppError extends Error {
  readonly kind: AppErrorKind;
  readonly retryable: boolean;
  // How long the other side asked us to wait, when it said
  readonly retryAfterMs?: number;
  readonly status?: number;

  constructor(
    kind: AppErrorKind,
    message: string,
    options: { cause?: unknown; retryAfterMs?: number; status?: number; retryable?: boolean } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.kind = kind;
    this.retryable = options.retryable ?? RETRYABLE.has(kind);
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
  }

  static isInstance(error: unknown): error is AppError {
    return error instanceof AppError || (error as { name?: string } | null)?.name === 'AppError';
  }
}

/** Milliseconds from a Retry-After header: seconds, or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** The kind an HTTP status means. */
export function kindOfStatus(status: number): AppErrorKind {
  if (status === 401) return 'auth';
  if (status === 402) return 'quota';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status === 400 || status === 409 || status === 413 || status === 422) return 'invalid';
  if (status >= 500) return 'unavailable';
  return 'unknown';
}

interface StatusLike {
  statusCode?: number;
  status?: number;
  responseHeaders?: Record<string, string>;
  headers?: { get?: (name: string) => string | null } | Record<string, string>;
  isRetryable?: boolean;
  name?: string;
  message?: string;
  code?: string | number;
}

function headerOf(error: StatusLike, name: string): string | null {
  const headers = error.responseHeaders ?? error.headers;
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get: (key: string) => string | null }).get(name);
  }
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()] ?? null;
}

/**
 * Any thrown value as an AppError: AI SDK API errors (statusCode + responseHeaders), fetch Responses,
 * aborts, timeouts and network failures. Unknown shapes become 'unknown', never retried.
 */
export function toAppError(error: unknown, fallback = 'Something went wrong.'): AppError {
  if (AppError.isInstance(error)) return error;
  const value = (error ?? {}) as StatusLike;
  const message = typeof value.message === 'string' && value.message ? value.message : fallback;

  if (value.name === 'AbortError') return new AppError('cancelled', 'Stopped.', { cause: error });
  if (value.name === 'TimeoutError') return new AppError('timeout', 'It took too long to answer.', { cause: error });

  const status = value.statusCode ?? (typeof value.status === 'number' ? value.status : undefined);
  if (status) {
    const kind = kindOfStatus(status);
    return new AppError(kind, message, {
      cause: error,
      status,
      retryAfterMs: parseRetryAfter(headerOf(value, 'retry-after')),
      // The AI SDK knows when a call must not be repeated
      retryable: value.isRetryable === false ? false : undefined,
    });
  }
  // fetch rejects with a TypeError when the network is down or the host refuses
  if (error instanceof TypeError || /network|fetch failed|ECONNREFUSED|ENOTFOUND|socket hang up/i.test(message)) {
    return new AppError('network', 'Could not reach the service.', { cause: error });
  }
  return new AppError('unknown', message, { cause: error });
}
