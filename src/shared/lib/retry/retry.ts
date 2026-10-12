import { AppError, toAppError } from '../errors/errors';

/**
 * Retrying with exponential back-off, one way everywhere. Only errors marked retryable are retried
 * (network, timeout, rate limit, unavailable); a wait the other side asked for is honoured; a stop
 * cancels at once. Side effects that are not idempotent must never be wrapped in this.
 */

export interface RetryPolicy {
  // Tries in all, including the first
  attempts: number;
  baseMs: number;
  capMs: number;
  // Waits longer than this are not slept through: the caller gets the error and schedules a job instead
  maxWaitMs?: number;
  signal?: AbortSignal;
  onRetry?: (error: AppError, attempt: number, waitMs: number) => void;
  // Stand-ins for tests
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const RETRY_POLICIES = {
  model: { attempts: 3, baseMs: 2000, capMs: 60_000, maxWaitMs: 60_000 },
  connectorRead: { attempts: 4, baseMs: 500, capMs: 15_000, maxWaitMs: 20_000 },
  companion: { attempts: 5, baseMs: 300, capMs: 10_000, maxWaitMs: 20_000 },
  embedding: { attempts: 3, baseMs: 1000, capMs: 20_000, maxWaitMs: 20_000 },
} satisfies Record<string, Omit<RetryPolicy, 'signal' | 'onRetry'>>;

/** Full-jitter back-off: a random wait up to min(cap, base·2^n). */
export function backoffMs(attempt: number, policy: Pick<RetryPolicy, 'baseMs' | 'capMs' | 'random'>): number {
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** attempt);
  return Math.round(ceiling * (policy.random ?? Math.random)());
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AppError('cancelled', 'Stopped.'));
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', stop);
      resolve();
    }
    function stop() {
      clearTimeout(timer);
      reject(new AppError('cancelled', 'Stopped.'));
    }
    signal?.addEventListener('abort', stop, { once: true });
  });
}

export async function withRetry<T>(work: (attempt: number) => Promise<T>, policy: RetryPolicy): Promise<T> {
  const sleep = policy.sleep ?? abortableSleep;
  for (let attempt = 0; ; attempt++) {
    if (policy.signal?.aborted) throw new AppError('cancelled', 'Stopped.');
    try {
      return await work(attempt);
    } catch (thrown) {
      const error = toAppError(thrown);
      if (!error.retryable || attempt + 1 >= policy.attempts || policy.signal?.aborted) throw error;
      const wait = error.retryAfterMs ?? backoffMs(attempt, policy);
      if (policy.maxWaitMs !== undefined && wait > policy.maxWaitMs) throw error;
      policy.onRetry?.(error, attempt + 1, wait);
      await sleep(wait, policy.signal);
    }
  }
}

/**
 * Stops calling a service that keeps failing: after `threshold` failures within `windowMs` it opens
 * and fails fast; after `cooldownMs` one trial call goes through (half-open), and a success closes it.
 * State can be saved and restored, so a restarted background keeps knowing a service is down.
 */
export class CircuitBreaker {
  private failures: number[] = [];
  private openedAt: number | null = null;

  constructor(
    private readonly options: { threshold: number; windowMs: number; cooldownMs: number } = {
      threshold: 5,
      windowMs: 60_000,
      cooldownMs: 120_000,
    },
  ) {}

  state(now = Date.now()): 'closed' | 'open' | 'half_open' {
    if (this.openedAt === null) return 'closed';
    return now - this.openedAt >= this.options.cooldownMs ? 'half_open' : 'open';
  }

  /** Throws instead of calling while the service is known to be down. */
  async call<T>(work: () => Promise<T>, now = Date.now): Promise<T> {
    if (this.state(now()) === 'open') {
      throw new AppError('unavailable', 'The service is down for now; it will be tried again shortly.', {
        retryable: false,
      });
    }
    try {
      const result = await work();
      this.failures = [];
      this.openedAt = null;
      return result;
    } catch (error) {
      const appError = toAppError(error);
      // Only failures of the service count; a bad request or a stop says nothing about its health
      if (appError.retryable || appError.kind === 'unavailable') this.recordFailure(now());
      throw appError;
    }
  }

  private recordFailure(at: number): void {
    if (this.state(at) === 'half_open') {
      this.openedAt = at;
      return;
    }
    this.failures = [...this.failures.filter(time => at - time < this.options.windowMs), at];
    if (this.failures.length >= this.options.threshold) this.openedAt = at;
  }

  snapshot(): { failures: number[]; openedAt: number | null } {
    return { failures: [...this.failures], openedAt: this.openedAt };
  }

  restore(snapshot: { failures: number[]; openedAt: number | null }): void {
    this.failures = [...snapshot.failures];
    this.openedAt = snapshot.openedAt;
  }
}
