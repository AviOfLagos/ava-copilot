import { describe, expect, it, vi } from 'vitest';
import { AppError, parseRetryAfter, toAppError } from '../../errors/errors';
import { backoffMs, CircuitBreaker, withRetry } from '../retry';

const noSleep = vi.fn(async () => {});

describe('toAppError', () => {
  it('maps statuses, Retry-After, aborts and network failures', () => {
    const rateLimited = toAppError({ statusCode: 429, message: 'slow down', responseHeaders: { 'retry-after': '3' } });
    expect(rateLimited).toMatchObject({ kind: 'rate_limit', retryable: true, retryAfterMs: 3000 });
    expect(toAppError({ statusCode: 401, message: 'no' })).toMatchObject({ kind: 'auth', retryable: false });
    expect(toAppError({ statusCode: 503, message: 'down', isRetryable: false }).retryable).toBe(false);
    expect(toAppError(new DOMException('x', 'AbortError')).kind).toBe('cancelled');
    expect(toAppError(new TypeError('Failed to fetch')).kind).toBe('network');
    expect(toAppError('weird').kind).toBe('unknown');
  });

  it('reads Retry-After as seconds or a date', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('withRetry', () => {
  it('retries what can be retried, with back-off, then gives up', async () => {
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new AppError('unavailable', 'down');
    };
    await expect(withRetry(failing, { attempts: 3, baseMs: 100, capMs: 1000, sleep: noSleep })).rejects.toThrow('down');
    expect(calls).toBe(3);
  });

  it('never retries what cannot be, and stops when cancelled', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new AppError('invalid', 'bad');
        },
        { attempts: 5, baseMs: 1, capMs: 1, sleep: noSleep },
      ),
    ).rejects.toThrow('bad');
    expect(calls).toBe(1);
    const controller = new AbortController();
    controller.abort();
    await expect(
      withRetry(async () => 1, { attempts: 2, baseMs: 1, capMs: 1, signal: controller.signal }),
    ).rejects.toMatchObject({
      kind: 'cancelled',
    });
  });

  it('honours Retry-After, and hands back a wait too long to sleep through', async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        if (calls++ === 0) throw new AppError('rate_limit', 'wait', { retryAfterMs: 1500 });
        return 'ok';
      },
      { attempts: 3, baseMs: 1, capMs: 1, sleep: async ms => void waits.push(ms) },
    );
    expect(result).toBe('ok');
    expect(waits).toEqual([1500]);
    await expect(
      withRetry(
        async () => {
          throw new AppError('rate_limit', 'later', { retryAfterMs: 120_000 });
        },
        { attempts: 3, baseMs: 1, capMs: 1, maxWaitMs: 20_000, sleep: noSleep },
      ),
    ).rejects.toThrow('later');
  });

  it('backs off with full jitter under a cap', () => {
    expect(backoffMs(0, { baseMs: 100, capMs: 1000, random: () => 1 })).toBe(100);
    expect(backoffMs(3, { baseMs: 100, capMs: 1000, random: () => 1 })).toBe(800);
    expect(backoffMs(10, { baseMs: 100, capMs: 1000, random: () => 0.5 })).toBe(500);
  });
});

describe('CircuitBreaker', () => {
  it('opens after repeated failures, lets one trial through later, and closes on success', async () => {
    let now = 0;
    const clock = () => now;
    const breaker = new CircuitBreaker({ threshold: 2, windowMs: 1000, cooldownMs: 5000 });
    const down = () => Promise.reject(new AppError('unavailable', 'down'));
    await expect(breaker.call(down, clock)).rejects.toThrow();
    await expect(breaker.call(down, clock)).rejects.toThrow();
    expect(breaker.state(now)).toBe('open');
    await expect(breaker.call(async () => 'x', clock)).rejects.toMatchObject({ kind: 'unavailable', retryable: false });

    now = 6000;
    expect(breaker.state(now)).toBe('half_open');
    await expect(breaker.call(async () => 'up', clock)).resolves.toBe('up');
    expect(breaker.state(now)).toBe('closed');

    // A bad request says nothing about the service's health
    await expect(breaker.call(() => Promise.reject(new AppError('invalid', 'bad')), clock)).rejects.toThrow();
    expect(breaker.snapshot().failures).toEqual([]);
  });
});
