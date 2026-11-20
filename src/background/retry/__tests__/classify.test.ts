import { describe, expect, it } from 'vitest';
import { classify, MAX_AUTO_TRIES, nextRetryAt } from '../classify';

describe('the class of a run that ended with an error', () => {
  it('is temporary for a closed tab and a restarted background, whatever else is known', () => {
    expect(classify('tab_closed', null)).toBe('temporary');
    expect(classify('interrupted', null)).toBe('temporary');
    expect(classify('tab_closed', 'auth')).toBe('temporary');
  });

  it('is temporary for steps that kept failing (a page that did not load, a dropped network) and for the unknown', () => {
    expect(classify('failed', 'max_failures')).toBe('temporary');
    expect(classify('failed', 'unknown')).toBe('temporary');
    expect(classify('failed', null)).toBe('temporary');
  });

  it('needs the user for a model key, another extension on the tab, and a closed debugging bar', () => {
    for (const code of ['auth', 'forbidden', 'extension_conflict', 'debugger_closed'] as const) {
      expect(classify('failed', code)).toBe('needs_user');
    }
  });

  it('cannot be done when the site is blocked, the request is refused, or the steps ran out', () => {
    for (const code of ['url_not_allowed', 'bad_request', 'max_steps'] as const) {
      expect(classify('failed', code)).toBe('cannot');
    }
  });
});

describe('when the next try is due', () => {
  it('is after 1, 5, then 15 minutes, and then never', () => {
    const now = 1_000_000;
    expect(nextRetryAt(0, now)).toBe(now + 60_000);
    expect(nextRetryAt(1, now)).toBe(now + 5 * 60_000);
    expect(nextRetryAt(2, now)).toBe(now + 15 * 60_000);
    expect(nextRetryAt(3, now)).toBeNull();
    expect(MAX_AUTO_TRIES).toBe(3);
  });
});
