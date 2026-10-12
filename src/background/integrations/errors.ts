import { AppError, kindOfStatus, toAppError } from '@extension/shared';
import type { AppErrorKind } from '@extension/shared';
import { ErrorCode, McpError, SseError, StreamableHTTPError, UnauthorizedError } from './sdk';

/**
 * What went wrong with a connector, as an AppError with a plain sentence. What a server says about its own
 * failure is outside content: it never goes into these sentences (the cause keeps it for the log).
 */

// What the last HTTP answer said, read by the transport's fetch: the SDK's errors keep the status but drop headers
export interface HttpTrace {
  status: number | null;
  retryAfterMs?: number;
}

function sentence(kind: AppErrorKind, name: string): string {
  switch (kind) {
    case 'auth':
      return `${name} did not accept the sign-in. Sign in again in Connectors.`;
    case 'forbidden':
      return `${name} refused: the account it uses has no permission for that.`;
    case 'not_found':
      return `Nothing answers as an MCP server at ${name}'s address. Check the address in Connectors.`;
    case 'rate_limit':
      return `${name} asked to slow down. Try again in a little while.`;
    case 'timeout':
      return `${name} did not answer in time.`;
    case 'network':
      return `Could not reach ${name}.`;
    case 'unavailable':
      return `${name} is having trouble right now.`;
    case 'invalid':
      return `${name} refused the request as not valid.`;
    case 'quota':
      return `${name} says the account is out of quota.`;
    case 'cancelled':
      return 'Stopped.';
    default:
      return `${name} failed.`;
  }
}

/** The sentence for an error kind, for a connector called `name`. */
export function connectorSentence(kind: AppErrorKind, name: string): string {
  return sentence(kind, name);
}

function fromStatus(status: number, name: string, cause: unknown, trace?: HttpTrace): AppError {
  let kind = kindOfStatus(status);
  // A 4xx with no meaning of its own (405, 406, 415…) says the request was wrong, not that the server is down
  if (kind === 'unknown') kind = status < 500 ? 'invalid' : 'unavailable';
  return new AppError(kind, sentence(kind, name), {
    cause,
    status,
    retryAfterMs: trace?.status === status ? trace.retryAfterMs : undefined,
  });
}

/**
 * Any error from talking to a connector as an AppError: HTTP statuses from either transport, JSON-RPC errors,
 * sign-in failures, timeouts, stops and network failures.
 */
export function connectorError(thrown: unknown, name: string, trace?: HttpTrace): AppError {
  if (AppError.isInstance(thrown)) return thrown;
  if (thrown instanceof UnauthorizedError) return new AppError('auth', sentence('auth', name), { cause: thrown });
  if (thrown instanceof StreamableHTTPError && typeof thrown.code === 'number' && thrown.code >= 400) {
    return fromStatus(thrown.code, name, thrown, trace);
  }
  if (thrown instanceof SseError && typeof thrown.code === 'number' && thrown.code >= 400) {
    return fromStatus(thrown.code, name, thrown, trace);
  }
  if (thrown instanceof McpError) {
    switch (thrown.code) {
      case ErrorCode.RequestTimeout:
        return new AppError('timeout', sentence('timeout', name), { cause: thrown });
      case ErrorCode.ConnectionClosed:
        return new AppError('network', sentence('network', name), { cause: thrown });
      case ErrorCode.InvalidParams:
      case ErrorCode.InvalidRequest:
        return new AppError('invalid', sentence('invalid', name), { cause: thrown });
      case ErrorCode.MethodNotFound:
        return new AppError('not_found', `${name} does not offer that.`, { cause: thrown });
      default:
        return new AppError('unknown', sentence('unknown', name), { cause: thrown });
    }
  }
  // A failed request whose status the transport saw, wrapped in something else
  if (trace?.status && trace.status >= 400) return fromStatus(trace.status, name, thrown, trace);
  const generic = toAppError(thrown);
  return new AppError(generic.kind, sentence(generic.kind, name), {
    cause: thrown,
    retryAfterMs: generic.retryAfterMs,
    status: generic.status,
    retryable: generic.retryable,
  });
}

/** The server's own words about a refused request, when the agent needs them to fix its arguments. */
export function serverDetail(error: AppError): string | null {
  const cause = error.cause;
  if (
    cause instanceof McpError &&
    (cause.code === ErrorCode.InvalidParams || cause.code === ErrorCode.InvalidRequest)
  ) {
    return cause.message.replace(/^MCP error -?\d+:\s*/, '').slice(0, 500);
  }
  return null;
}
