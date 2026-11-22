import { describe, expect, it } from 'vitest';
import { formatWait, needsTicking, retryLine } from '../countdown';

// A stand-in for t(): the key and its substitutions, so the test checks what is chosen, not the wording
const tr = (key: string, subs: string[] = []) => `${key}(${subs.join(',')})`;

describe('formatWait', () => {
  it('counts seconds, then minutes, then hours, rounding up', () => {
    expect(formatWait(4000, tr)).toBe('retry_dur_s(4)');
    expect(formatWait(3200, tr)).toBe('retry_dur_s(4)');
    expect(formatWait(252_000, tr)).toBe('retry_dur_ms(4,12)');
    expect(formatWait(3_900_000, tr)).toBe('retry_dur_hm(1,5)');
    expect(formatWait(-5, tr)).toBe('retry_dur_s(0)');
  });
});

describe('retryLine', () => {
  const now = 10_000;
  it('counts down a step wait with its try number', () => {
    expect(retryLine({ kind: 'step', until: now + 4000, attempt: 2, max: 3 }, now, tr)).toBe(
      'retry_wait_step(retry_dur_s(4),2,3)',
    );
    expect(retryLine({ kind: 'step', until: now + 1000, attempt: 2, max: 3 }, now + 1000, tr)).toBe('retry_now()');
  });
  it('names the other kinds', () => {
    expect(retryLine({ kind: 'planning', until: now + 2000, attempt: 1, max: 3 }, now, tr)).toContain(
      'retry_wait_planning',
    );
    expect(retryLine({ kind: 'model', until: now + 2000, attempt: 1, max: 4 }, now, tr)).toContain('retry_wait_model');
    expect(retryLine({ kind: 'repair' }, now, tr)).toBe('retry_repair()');
    expect(retryLine({ kind: 'fallback' }, now, tr)).toBe('retry_fallback()');
  });
  it('says nothing without a status', () => {
    expect(retryLine(null, now, tr)).toBeNull();
    expect(retryLine(undefined, now, tr)).toBeNull();
  });
  it('ticks only while a wait is still ahead', () => {
    expect(needsTicking({ kind: 'step', until: now + 1 }, now)).toBe(true);
    expect(needsTicking({ kind: 'step', until: now }, now)).toBe(false);
    expect(needsTicking({ kind: 'repair' }, now)).toBe(false);
    expect(needsTicking(null, now)).toBe(false);
  });
});
