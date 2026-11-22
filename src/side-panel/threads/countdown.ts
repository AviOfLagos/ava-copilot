import type { t } from '@extension/i18n';
import type { RetryStatus } from '@src/background/retry/status';

type Key = Parameters<typeof t>[0];
type Translate = (key: Key, substitutions?: string[]) => string;

/** A wait as a short phrase that counts down: "4s", "4 min 12s", "1 h 5 min". Rounds up, so it never shows 0 early. */
export function formatWait(ms: number, translate: Translate): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  if (total < 60) return translate('retry_dur_s', [String(total)]);
  if (total < 3600) return translate('retry_dur_ms', [String(Math.floor(total / 60)), String(total % 60)]);
  return translate('retry_dur_hm', [String(Math.floor(total / 3600)), String(Math.floor((total % 3600) / 60))]);
}

/** The line for a wait before a retry, or null when there is nothing to say. `now` is passed in so it can tick. */
export function retryLine(status: RetryStatus | null | undefined, now: number, translate: Translate): string | null {
  if (!status) return null;
  switch (status.kind) {
    case 'repair':
      return translate('retry_repair');
    case 'fallback':
      return translate('retry_fallback');
    default: {
      if (status.until === undefined || status.until <= now) return translate('retry_now');
      return translate(
        status.kind === 'step'
          ? 'retry_wait_step'
          : status.kind === 'planning'
            ? 'retry_wait_planning'
            : 'retry_wait_model',
        [
          formatWait(status.until - now, translate),
          String(status.attempt ?? 1),
          String(status.max ?? status.attempt ?? 1),
        ],
      );
    }
  }
}

/** True while the line changes with the clock, so a ticking timer is needed. */
export function needsTicking(status: RetryStatus | null | undefined, now: number): boolean {
  return !!status && status.until !== undefined && status.until > now;
}
