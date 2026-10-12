/** Work scheduled for later or on a repeat: one table and one alarm run all of it. */
export interface JobRecord {
  id: string;
  // Which handler runs it
  kind: string;
  // Unique: scheduling the same key again replaces it
  key: string;
  runAt: number;
  // Repeats on this cron expression, in this time zone
  cron: string | null;
  timezone: string | null;
  payload: unknown;
  status: 'scheduled' | 'running' | 'done' | 'failed' | 'paused';
  attempts: number;
  leaseUntil: number | null;
  lastError: string | null;
  lastRunAt: number | null;
  // A run missed by more than this is skipped to the next one (a 07:30 routine does not fire at 22:00)
  catchUpMs: number;
  createdAt: number;
  updatedAt: number;
}
