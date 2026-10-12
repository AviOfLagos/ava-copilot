import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AviCopilotDb } from '@extension/storage';
import { AppError } from '@extension/shared';
import { JobRunner, nextCronRun, registerJobHandler } from '../runner';

let db: AviCopilotDb;
let now: number;
let runner: JobRunner;
const ran: string[] = [];

beforeEach(() => {
  db = new AviCopilotDb(`jobs-${crypto.randomUUID()}`);
  now = new Date(2026, 9, 12, 7, 0).getTime();
  runner = new JobRunner(db, () => now);
  ran.length = 0;
});

registerJobHandler('note', async job => void ran.push(job.key));
let failures = 0;
registerJobHandler('flaky', async () => {
  if (failures-- > 0) throw new AppError('unavailable', 'down');
  ran.push('flaky');
});
registerJobHandler('broken', async () => {
  throw new AppError('invalid', 'bad input');
});

describe('JobRunner', () => {
  it('runs a one-off job when due, once', async () => {
    await runner.schedule({ kind: 'note', key: 'once', runAt: now + 60_000 });
    await runner.tick();
    expect(ran).toEqual([]);
    now += 60_000;
    await runner.tick();
    await runner.tick();
    expect(ran).toEqual(['once']);
    expect((await db.jobs.where('key').equals('once').first())?.status).toBe('done');
  });

  it('repeats on its cron, and skips a time it missed by too much', async () => {
    await runner.schedule({ kind: 'note', key: 'daily', cron: '30 7 * * *', catchUpMs: 60 * 60_000 });
    const job = await db.jobs.where('key').equals('daily').first();
    expect(new Date(job!.runAt).getHours()).toBe(7);
    now = job!.runAt;
    await runner.tick();
    expect(ran).toEqual(['daily']);
    const next = (await db.jobs.where('key').equals('daily').first())!.runAt;
    expect(next - now).toBe(24 * 60 * 60_000);

    // The browser was closed all day: the next run comes up at 22:00, too late to run
    now = next + 14.5 * 60 * 60_000;
    await runner.tick();
    expect(ran).toEqual(['daily']);
    expect((await db.jobs.where('key').equals('daily').first())!.runAt).toBeGreaterThan(now);
  });

  it('retries a failure that can be retried, with back-off, and gives up on one that cannot', async () => {
    failures = 1;
    await runner.schedule({ kind: 'flaky', key: 'flaky', runAt: now });
    await runner.tick();
    const waiting = (await db.jobs.where('key').equals('flaky').first())!;
    expect(waiting.status).toBe('scheduled');
    expect(waiting.runAt).toBeGreaterThanOrEqual(now);
    now = waiting.runAt;
    await runner.tick();
    expect(ran).toEqual(['flaky']);

    await runner.schedule({ kind: 'broken', key: 'broken', runAt: now });
    await runner.tick();
    const broken = (await db.jobs.where('key').equals('broken').first())!;
    expect(broken.status).toBe('failed');
    expect(broken.lastError).toBe('bad input');
  });

  it('takes back a job left running past its lease, even without a restart', async () => {
    const job = await runner.schedule({ kind: 'note', key: 'cut', runAt: now });
    await db.jobs.update(job.id, { status: 'running', leaseUntil: now + 1000 });
    await runner.tick();
    expect(ran).toEqual([]);
    now += 2000;
    await runner.tick();
    expect(ran).toEqual(['cut']);
  });

  it('replaces a job scheduled again under the same key, and knows a cron that never fires', async () => {
    await runner.schedule({ kind: 'note', key: 'k', runAt: now + 1000 });
    await runner.schedule({ kind: 'note', key: 'k', runAt: now + 5000 });
    expect(await db.jobs.count()).toBe(1);
    expect(nextCronRun('0 0 30 2 *', null, now)).toBeNull();
  });

  it('never runs a job twice when two ticks come together', async () => {
    let calls = 0;
    registerJobHandler('slow', async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    await runner.schedule({ kind: 'slow', key: 'slow', runAt: now });
    await Promise.all([runner.tick(), runner.tick(), runner.tick()]);
    expect(calls).toBe(1);
  });

  it('takes back a job a stopped background left running, right after the restart', async () => {
    const job = await runner.schedule({ kind: 'note', key: 'orphan', runAt: now });
    await db.jobs.update(job.id, { status: 'running', leaseUntil: now + 10 * 60_000 });
    // A fresh runner, as after a restart, runs none of them
    const fresh = new JobRunner(db, () => now);
    await fresh.recover();
    await fresh.tick();
    expect(ran).toContain('orphan');
  });
});
