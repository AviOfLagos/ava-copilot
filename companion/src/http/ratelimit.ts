/**
 * Per-route rate limits: one token bucket per route group (and caller, when given). A bucket holds up to
 * `capacity` requests and refills at `perMinute`; an empty bucket answers 429 with how long to wait.
 */

export interface RateRule {
  capacity: number;
  perMinute: number;
}

// The extension is the only legitimate caller, so these are generous for it and tight for guessing
export const RATE_RULES = {
  // One-time codes: a few tries, then wait
  pair: { capacity: 5, perMinute: 5 },
  health: { capacity: 30, perMinute: 60 },
  read: { capacity: 60, perMinute: 240 },
  run: { capacity: 20, perMinute: 30 },
  sessions: { capacity: 30, perMinute: 60 },
  stream: { capacity: 30, perMinute: 120 },
  studio: { capacity: 20, perMinute: 30 },
  view: { capacity: 300, perMinute: 1200 },
  internal: { capacity: 200, perMinute: 2000 },
} satisfies Record<string, RateRule>;

export type RateGroup = keyof typeof RATE_RULES;

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly rules: Record<string, RateRule> = RATE_RULES,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one request from the bucket: ok, or how many milliseconds until one is free. */
  take(group: string, caller = ''): { ok: true } | { ok: false; retryAfterMs: number } {
    const rule = this.rules[group];
    if (!rule) return { ok: true };
    const key = `${group}:${caller}`;
    const now = this.now();
    const refillPerMs = rule.perMinute / 60_000;
    const bucket = this.buckets.get(key) ?? { tokens: rule.capacity, at: now };
    bucket.tokens = Math.min(rule.capacity, bucket.tokens + (now - bucket.at) * refillPerMs);
    bucket.at = now;
    this.buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterMs: Math.ceil((1 - bucket.tokens) / refillPerMs) };
  }
}
