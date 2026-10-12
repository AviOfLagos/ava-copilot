/** Numbers the rest of the Inbox stream shares, gathered here so tests and modules agree on them. */

// A source that lands more than RATE_LIMIT_THRESHOLD "message" items within this window gets folded
// into one digest item instead of flooding the list.
export const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export const RATE_LIMIT_THRESHOLD = 5;

// Done items older than this are removed by the retention job.
export const RETENTION_DAYS = 30;
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

// Desktop notifications (high priority only) never arrive closer together than this.
export const NOTIFY_MIN_GAP_MS = 2 * 60 * 1000;

// Spoken announcements (any priority) never arrive closer together than this.
export const ANNOUNCE_MIN_GAP_MS = 3 * 60 * 1000;

// Tab watchers read open tabs on this cadence.
export const WATCH_CRON = '*/2 * * * *';
export const WATCH_JOB_KEY = 'inbox-watch';

export const RETENTION_JOB_KEY = 'inbox-retention';
export const RETENTION_CRON = '0 4 * * *';

export const snoozeJobKey = (itemId: string) => `inbox-snooze:${itemId}`;
