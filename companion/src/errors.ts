import { AppError, toAppError } from '@extension/shared';
import type { AppErrorKind } from '@extension/shared';
import { STATUS_OF_KIND } from '@protocol';
import type { ErrorReply } from '@protocol';
import { redact } from './log';

export { AppError, toAppError };
export type { AppErrorKind };

/** Throws a plain-sentence error of a kind the protocol knows. */
export function fail(kind: AppErrorKind, message: string, options: { retryAfterMs?: number } = {}): never {
  throw new AppError(kind, message, { retryAfterMs: options.retryAfterMs });
}

export const DOCKER_DOWN_MESSAGE = 'Docker is not running. Start Docker Desktop, then try again.';
export const DOCKER_MISSING_MESSAGE = 'Docker is not installed. Install Docker Desktop to run code on this Mac.';

/** Any thrown value as the protocol's error reply and its HTTP status. Messages are redacted. */
export function errorReply(error: unknown): { status: number; body: ErrorReply } {
  const appError = toAppError(error, 'Something went wrong on the Mac.');
  // An error nobody turned into a sentence on purpose may hold internals: say something generic instead
  const plain = AppError.isInstance(error) || appError.kind !== 'unknown';
  const message = plain ? redact(appError.message).slice(0, 1000) : 'Something went wrong on the Mac.';
  return {
    status: STATUS_OF_KIND[appError.kind] ?? 500,
    body: {
      ok: false,
      error: {
        kind: appError.kind,
        message,
        ...(appError.retryAfterMs !== undefined ? { retryAfterMs: Math.round(appError.retryAfterMs) } : {}),
      },
    },
  };
}
