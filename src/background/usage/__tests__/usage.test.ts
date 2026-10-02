import { describe, expect, it } from 'vitest';
import { APICallError } from 'ai';
import { addTotals, localDay } from '@extension/storage';
import { isOverCap, formatUsd } from '../budget';
import { MAX_RATE_LIMIT_RETRIES, retryDelay } from '../meter';
import { costOf, priceFor } from '../pricing';
import type { ModelPrice } from '../pricing';

const apiError = (statusCode: number | undefined, responseHeaders?: Record<string, string>) =>
  new APICallError({
    message: 'failed',
    url: 'https://example.test',
    requestBodyValues: {},
    statusCode,
    responseHeaders,
  });

describe('priceFor', () => {
  const prices: ModelPrice[] = [
    { model: 'flash', input: 1, output: 4 },
    { model: 'flash', from: '2027-01-01', input: 2, output: 8 },
  ];

  it('uses the price in force on the day of the call', () => {
    expect(priceFor('flash', '2026-12-31', prices)?.input).toBe(1);
    expect(priceFor('flash', '2027-01-01', prices)?.input).toBe(2);
    expect(priceFor('flash', '2028-06-01', prices)?.input).toBe(2);
  });

  it('has no price for an unknown model', () => {
    expect(priceFor('qwen3.8', '2026-10-02')).toBeNull();
  });
});

describe('costOf', () => {
  it('prices input and output per million tokens', () => {
    expect(costOf('gemini-3.8-flash', 1_000_000, 0, '2026-10-02')).toBeCloseTo(0.75);
    expect(costOf('gemini-3.8-flash', 0, 1_000_000, '2026-10-02')).toBeCloseTo(3.75);
    expect(costOf('gemini-3.8-flash', 20_000, 1_000, '2026-10-02')).toBeCloseTo(0.01875);
  });

  it('uses the long-prompt price above the threshold', () => {
    expect(costOf('gemini-3.1-pro-preview', 200_000, 1_000, '2026-10-02')).toBeCloseTo(0.412);
    expect(costOf('gemini-3.1-pro-preview', 200_001, 1_000, '2026-10-02')).toBeCloseTo(0.818004);
  });

  it('gives no cost for a model with no known price', () => {
    expect(costOf('some-local-model', 5000, 500, '2026-10-02')).toBeNull();
  });
});

describe('retryDelay', () => {
  it('backs off exponentially on rate limits and outages', () => {
    expect(retryDelay(apiError(429), 0)).toBe(2000);
    expect(retryDelay(apiError(429), 1)).toBe(4000);
    expect(retryDelay(apiError(503), 2)).toBe(8000);
    expect(retryDelay(apiError(503), 3)).toBe(16000);
  });

  it('gives up after the last retry', () => {
    expect(retryDelay(apiError(429), MAX_RATE_LIMIT_RETRIES)).toBeNull();
  });

  it('follows the Retry-After header, up to a minute', () => {
    expect(retryDelay(apiError(429, { 'retry-after': '7' }), 0)).toBe(7000);
    expect(retryDelay(apiError(429, { 'retry-after': '600' }), 0)).toBe(60000);
    expect(retryDelay(apiError(429, { 'retry-after': 'soon' }), 1)).toBe(4000);
  });

  it('does not retry errors that waiting cannot fix', () => {
    expect(retryDelay(apiError(400), 0)).toBeNull();
    expect(retryDelay(apiError(401), 0)).toBeNull();
    expect(retryDelay(apiError(undefined), 0)).toBeNull();
    expect(retryDelay(new Error('boom'), 0)).toBeNull();
  });
});

describe('isOverCap', () => {
  it('holds once the spend reaches the cap', () => {
    expect(isOverCap(4.99, 5)).toBe(false);
    expect(isOverCap(5, 5)).toBe(true);
    expect(isOverCap(12, 5)).toBe(true);
  });

  it('treats a cap of zero as no cap', () => {
    expect(isOverCap(1000, 0)).toBe(false);
  });

  it('formats amounts in dollars and cents', () => {
    expect(formatUsd(5)).toBe('$5.00');
    expect(formatUsd(0.126)).toBe('$0.13');
  });
});

describe('usage totals', () => {
  it('adds two totals field by field', () => {
    expect(
      addTotals(
        { inputTokens: 10, outputTokens: 2, costUsd: 0.5, calls: 1, unpricedCalls: 0 },
        { inputTokens: 5, outputTokens: 1, costUsd: 0.25, calls: 1, unpricedCalls: 1 },
      ),
    ).toEqual({ inputTokens: 15, outputTokens: 3, costUsd: 0.75, calls: 2, unpricedCalls: 1 });
  });

  it('names a day by the local calendar date', () => {
    expect(localDay(new Date(2026, 9, 2, 23, 59))).toBe('2026-10-02');
    expect(localDay(new Date(2027, 0, 5, 0, 1))).toBe('2027-01-05');
  });
});
