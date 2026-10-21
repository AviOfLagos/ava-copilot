/**
 * When an automatic backup runs after changes: 2 minutes after the last change, but no later than 10 minutes
 * after the first one (a long-running chat does not hold it off for ever), and never sooner than 10 minutes after
 * the previous backup. The run itself is a job (one key, rescheduled), so it survives the worker stopping;
 * this only decides its time, and asks the job store again only when that time moved noticeably.
 */

export const DEBOUNCE_MS = 2 * 60_000;
export const MAX_DELAY_MS = 10 * 60_000;
export const MIN_INTERVAL_MS = 10 * 60_000;
// Rescheduling the job for a shift smaller than this is not worth a write
const SLACK_MS = 15_000;

export interface ChangeTrackerDeps {
  now: () => number;
  schedule: (runAt: number) => Promise<void>;
  // No backups now (a restore runs, or setup is not finished)
  paused?: () => boolean;
}

export class ChangeTracker {
  private firstChangeAt: number | null = null;
  private planned: number | null = null;
  private lastBackupAt: number | null = null;

  constructor(private readonly deps: ChangeTrackerDeps) {}

  setLastBackup(at: number | null): void {
    this.lastBackupAt = at;
  }

  /** Something the user keeps changed. Returns when the backup is planned, or null when nothing was scheduled. */
  touch(): number | null {
    if (this.deps.paused?.()) return null;
    const now = this.deps.now();
    this.firstChangeAt ??= now;
    const due = Math.min(now + DEBOUNCE_MS, this.firstChangeAt + MAX_DELAY_MS);
    const runAt = Math.max(due, (this.lastBackupAt ?? 0) + MIN_INTERVAL_MS);
    if (this.planned !== null && Math.abs(runAt - this.planned) < SLACK_MS) return null;
    this.planned = runAt;
    void this.deps.schedule(runAt).catch(() => {
      this.planned = null;
    });
    return runAt;
  }

  /** A backup ran: changes from now on are new ones. */
  ran(at: number): void {
    this.lastBackupAt = at;
    this.firstChangeAt = null;
    this.planned = null;
  }
}
