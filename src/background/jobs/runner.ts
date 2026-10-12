import { Cron } from 'croner';
import { db as defaultDb } from '@extension/storage';
import type { AviCopilotDb, JobRecord } from '@extension/storage';
import { backoffMs, toAppError } from '@extension/shared';
import { createLogger } from '../log';

/**
 * The one scheduler: every routine, poller, delayed retry and repeat is a row in `jobs`, and one
 * alarm runs whatever is due. Jobs survive the background stopping: a job cut off mid-run is picked up
 * again after its lease runs out. A repeating job missed by more than its catch-up window is skipped to
 * its next time instead of running late.
 */

const logger = createLogger('Jobs');

export const JOBS_ALARM = 'jobs';
// How long a running job holds its claim before a restarted background may take it again
const LEASE_MS = 10 * 60 * 1000;
// At most this many jobs at once, so routines never crowd out the user's own work
const CONCURRENCY = 2;
// A failing job is tried this many times, with back-off, before it is marked failed
const MAX_ATTEMPTS = 5;
const DEFAULT_CATCH_UP_MS = 2 * 60 * 60 * 1000;

export type JobHandler = (job: JobRecord, signal: AbortSignal) => Promise<void>;

const handlers = new Map<string, JobHandler>();

/** Says what runs a kind of job. Registered at startup, before the first tick. */
export function registerJobHandler(kind: string, handler: JobHandler): void {
  handlers.set(kind, handler);
}

export interface ScheduleRequest {
  kind: string;
  // Unique: scheduling the same key again replaces the job
  key: string;
  // A one-off time, or a cron expression for a repeat
  runAt?: number;
  cron?: string;
  timezone?: string;
  payload?: unknown;
  catchUpMs?: number;
}

/** The next time a cron expression fires after `after`, or null if never. Throws on a bad expression. */
export function nextCronRun(cron: string, timezone: string | null, after: number): number | null {
  const next = new Cron(cron, { timezone: timezone ?? undefined, paused: true }).nextRun(new Date(after));
  return next ? next.getTime() : null;
}

export class JobRunner {
  private running = new Map<string, AbortController>();

  constructor(
    private readonly db: AviCopilotDb = defaultDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** Arms the alarm once (re-creating it on every start would reset its timer) and follows it. */
  async start(): Promise<void> {
    chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === JOBS_ALARM) void this.tick();
    });
    if (!(await chrome.alarms.get(JOBS_ALARM))) await chrome.alarms.create(JOBS_ALARM, { periodInMinutes: 0.5 });
  }

  async schedule(request: ScheduleRequest): Promise<JobRecord> {
    const now = this.now();
    const runAt = request.cron ? nextCronRun(request.cron, request.timezone ?? null, now) : (request.runAt ?? now);
    if (runAt === null) throw new Error(`The schedule "${request.cron}" never runs`);
    const existing = await this.db.jobs.where('key').equals(request.key).first();
    const job: JobRecord = {
      id: existing?.id ?? crypto.randomUUID(),
      kind: request.kind,
      key: request.key,
      runAt,
      cron: request.cron ?? null,
      timezone: request.timezone ?? null,
      payload: request.payload ?? null,
      status: 'scheduled',
      attempts: 0,
      leaseUntil: null,
      lastError: null,
      lastRunAt: existing?.lastRunAt ?? null,
      catchUpMs: request.catchUpMs ?? DEFAULT_CATCH_UP_MS,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.db.jobs.put(job);
    return job;
  }

  async cancel(key: string): Promise<void> {
    this.running.get(key)?.abort();
    await this.db.jobs.where('key').equals(key).delete();
  }

  async setPaused(key: string, paused: boolean): Promise<void> {
    const job = await this.db.jobs.where('key').equals(key).first();
    if (!job) return;
    await this.db.jobs.update(job.id, { status: paused ? 'paused' : 'scheduled', updatedAt: this.now() });
  }

  /** Jobs cut off by a stopped background go back to the queue once their lease is over. */
  async recover(): Promise<void> {
    const now = this.now();
    const stale = await this.db.jobs.where('status').equals('running').toArray();
    for (const job of stale) {
      if ((job.leaseUntil ?? 0) < now) {
        await this.db.jobs.update(job.id, { status: 'scheduled', leaseUntil: null, updatedAt: now });
        logger.info(`Job ${job.key} was interrupted and is queued again`);
      }
    }
  }

  /** Runs what is due, a few at a time. */
  async tick(): Promise<void> {
    const now = this.now();
    const due = await this.db.jobs
      .where('runAt')
      .belowOrEqual(now)
      .filter(job => job.status === 'scheduled' && !this.running.has(job.key))
      .sortBy('runAt');
    const free = CONCURRENCY - this.running.size;
    await Promise.all(due.slice(0, Math.max(0, free)).map(job => this.run(job)));
  }

  private async run(job: JobRecord): Promise<void> {
    const now = this.now();
    // A repeat missed by too much moves to its next time instead of running late
    if (job.cron && now - job.runAt > job.catchUpMs) {
      const next = nextCronRun(job.cron, job.timezone, now);
      await this.db.jobs.update(job.id, {
        runAt: next ?? job.runAt,
        status: next ? 'scheduled' : 'done',
        updatedAt: now,
      });
      logger.info(`Job ${job.key} missed its time and moves to the next one`);
      return;
    }
    const handler = handlers.get(job.kind);
    if (!handler) {
      await this.db.jobs.update(job.id, { status: 'failed', lastError: `No handler for ${job.kind}`, updatedAt: now });
      return;
    }

    const controller = new AbortController();
    this.running.set(job.key, controller);
    const attempts = job.attempts + 1;
    await this.db.jobs.update(job.id, { status: 'running', attempts, leaseUntil: now + LEASE_MS, updatedAt: now });
    // A running job keeps the background awake
    const keepAlive = setInterval(() => void chrome.runtime?.getPlatformInfo?.(), 20_000);
    try {
      await handler({ ...job, attempts }, controller.signal);
      const after = this.now();
      const next = job.cron ? nextCronRun(job.cron, job.timezone, after) : null;
      await this.db.jobs.update(job.id, {
        status: next ? 'scheduled' : 'done',
        runAt: next ?? job.runAt,
        attempts: 0,
        leaseUntil: null,
        lastError: null,
        lastRunAt: after,
        updatedAt: after,
      });
    } catch (thrown) {
      const error = toAppError(thrown);
      const after = this.now();
      const again = error.retryable && attempts < MAX_ATTEMPTS;
      // A repeat that keeps failing still comes back at its next time
      const next = !again && job.cron ? nextCronRun(job.cron, job.timezone, after) : null;
      await this.db.jobs.update(job.id, {
        status: again || next ? 'scheduled' : 'failed',
        runAt: again
          ? after + (error.retryAfterMs ?? backoffMs(attempts, { baseMs: 30_000, capMs: 30 * 60_000 }))
          : (next ?? job.runAt),
        attempts: again ? attempts : 0,
        leaseUntil: null,
        lastError: error.message.slice(0, 300),
        lastRunAt: after,
        updatedAt: after,
      });
      logger.warning(`Job ${job.key} failed (${error.kind})`);
    } finally {
      clearInterval(keepAlive);
      this.running.delete(job.key);
    }
  }
}

export const jobs = new JobRunner();
