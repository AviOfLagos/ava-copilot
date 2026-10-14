import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulkDailyCount, BulkRecipient, BulkRun } from '@extension/storage';
import type { BulkDeps as Deps } from '../bulk/runner';

// The storage module reads globalThis.chrome when imported, so the mock exists first
const data = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string | string[]) =>
          Object.fromEntries(
            [keys]
              .flat()
              .filter(k => k in values)
              .map(k => [k, structuredClone(values[k])]),
          ),
        set: async (items: Record<string, unknown>) => Object.assign(values, structuredClone(items)),
        remove: async (keys: string | string[]) => [keys].flat().forEach(k => delete values[k]),
        onChanged: { addListener: () => undefined },
      },
    },
  });
  return values;
});

const { advanceRun, settleInterrupted, INLINE_WAIT_MS } = await import('../bulk/runner');
const { addRun, getRun } = await import('../bulk/state');

const recipient = (phone: string, status: BulkRecipient['status'] = 'pending'): BulkRecipient => ({
  phone,
  name: phone,
  fields: {},
  message: `Hi ${phone}`,
  status,
  reason: '',
  at: null,
});

function makeRun(over: Partial<BulkRun> = {}): BulkRun {
  return {
    id: crypto.randomUUID(),
    workspaceId: null,
    template: 'Hi',
    attachment: null,
    settings: {
      delayMinSec: 8,
      delayMaxSec: 20,
      cooldownEvery: 2,
      cooldownMinSec: 120,
      cooldownMaxSec: 300,
      dailyCap: 50,
    },
    recipients: ['11111111', '22222222', '33333333', '44444444'].map(phone => recipient(phone)),
    status: 'running',
    approvalId: crypto.randomUUID(),
    approvedAt: 1,
    sinceCooldown: 0,
    nextAt: null,
    note: '',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** A fake clock that moves only when the runner sleeps, and records what happened. */
function fakeDeps(over: Partial<Deps> = {}) {
  let clock = 1_000_000;
  let daily: BulkDailyCount = { day: '2026-10-14', sent: 0 };
  const log = {
    sentAt: [] as { phone: string; at: number }[],
    scheduled: [] as number[],
    notes: [] as string[],
    slept: [] as number[],
  };
  const deps: Deps = {
    now: () => clock,
    sleep: async ms => {
      log.slept.push(ms);
      clock += ms;
    },
    random: () => 0,
    today: () => '2026-10-14',
    nextDayAt: () => 9_999_999_999,
    checkTab: async () => ({ ok: true, tabId: 7 }),
    send: async (_tabId, r) => {
      log.sentAt.push({ phone: r.phone, at: clock });
      return { status: 'sent' };
    },
    scheduleAt: async (_id, at) => {
      log.scheduled.push(at);
    },
    note: async (_run, note) => {
      log.notes.push(note);
    },
    getDaily: async () => daily,
    setDaily: async count => {
      daily = count;
    },
    ...over,
  };
  return {
    deps,
    log,
    advance: (ms: number) => (clock += ms),
    setDaily: (count: BulkDailyCount) => (daily = count),
    get daily() {
      return daily;
    },
  };
}

const signal = new AbortController().signal;

describe('bulk runner pacing', () => {
  beforeEach(() => {
    for (const key of Object.keys(data)) delete data[key];
  });

  it('waits the random gap inline, then hands the cooldown to a job', async () => {
    const run = await addRun(makeRun());
    const fake = fakeDeps();
    await advanceRun(run.id, fake.deps, signal);

    // Two messages 8 s apart (random() = 0 picks the minimum), then a 120 s cooldown: too long for a timer
    expect(fake.log.sentAt.map(entry => entry.phone)).toEqual(['11111111', '22222222']);
    expect(fake.log.sentAt[1].at - fake.log.sentAt[0].at).toBe(8000);
    expect(fake.log.slept).toEqual([8000]);
    const stored = await getRun(run.id);
    expect(stored?.sinceCooldown).toBe(0);
    expect(fake.log.scheduled).toEqual([fake.log.sentAt[1].at + 120_000]);
    expect(stored?.nextAt).toBe(fake.log.sentAt[1].at + 120_000);

    // The job comes back after the cooldown and the rest goes out
    fake.advance(120_000);
    await advanceRun(run.id, fake.deps, signal);
    expect(fake.log.sentAt.map(entry => entry.phone)).toEqual(['11111111', '22222222', '33333333', '44444444']);
    expect((await getRun(run.id))?.status).toBe('done');
    expect(fake.log.notes).toEqual(['done']);
    expect(fake.daily).toEqual({ day: '2026-10-14', sent: 4 });
  });

  it('does not send before nextAt when the job fires early', async () => {
    const fake = fakeDeps();
    const run = await addRun(makeRun({ nextAt: 1_000_000 + INLINE_WAIT_MS + 1 }));
    await advanceRun(run.id, fake.deps, signal);
    expect(fake.log.sentAt).toEqual([]);
    expect(fake.log.scheduled).toEqual([1_000_000 + INLINE_WAIT_MS + 1]);
  });

  it('pauses at the daily cap and schedules the next day', async () => {
    const fake = fakeDeps();
    fake.setDaily({ day: '2026-10-14', sent: 49 });
    const run = await addRun(makeRun({ settings: { ...makeRun().settings, cooldownEvery: 10 } }));
    await advanceRun(run.id, fake.deps, signal);
    expect(fake.log.sentAt).toHaveLength(1);
    const stored = await getRun(run.id);
    expect(stored).toMatchObject({ status: 'paused', note: 'daily_cap' });
    expect(fake.log.notes).toEqual(['daily_cap']);
    expect(fake.log.scheduled).toEqual([9_999_999_999]);

    // A new day: the paused run goes on by itself
    fake.setDaily({ day: '2026-10-13', sent: 50 });
    await advanceRun(run.id, fake.deps, signal);
    expect(fake.log.sentAt.length).toBeGreaterThan(1);
  });

  it('stops moving when paused, and does nothing while waiting for approval', async () => {
    const fake = fakeDeps();
    const paused = await addRun(makeRun({ status: 'paused' }));
    const waiting = await addRun(makeRun({ status: 'awaiting_approval' }));
    await advanceRun(paused.id, fake.deps, signal);
    await advanceRun(waiting.id, fake.deps, signal);
    expect(fake.log.sentAt).toEqual([]);
  });

  it('waits for the tab with an Inbox note when it is closed', async () => {
    const fake = fakeDeps({ checkTab: async () => ({ ok: false, reason: 'tab_closed' }) });
    const run = await addRun(makeRun());
    await advanceRun(run.id, fake.deps, signal);
    expect(await getRun(run.id)).toMatchObject({ status: 'waiting_tab', note: 'tab_closed' });
    expect(fake.log.notes).toEqual(['tab_closed']);
    expect(fake.log.sentAt).toEqual([]);
  });

  it('skips a number WhatsApp rejects and goes on', async () => {
    let calls = 0;
    const fake = fakeDeps({
      send: async () => (calls++ === 0 ? { status: 'skipped', reason: 'not_on_whatsapp' } : { status: 'sent' }),
    });
    const run = await addRun(makeRun({ recipients: [recipient('11111111'), recipient('22222222')] }));
    await advanceRun(run.id, fake.deps, signal);
    const stored = await getRun(run.id);
    expect(stored?.recipients.map(r => [r.status, r.reason])).toEqual([
      ['skipped', 'not_on_whatsapp'],
      ['sent', ''],
    ]);
    expect(fake.daily.sent).toBe(1);
  });

  it('never sends a message cut off mid-send again', async () => {
    const fake = fakeDeps();
    const run = await addRun(makeRun({ recipients: [recipient('11111111', 'sending'), recipient('22222222')] }));
    await settleInterrupted(run.id, fake.deps);
    await advanceRun(run.id, fake.deps, signal);
    const stored = await getRun(run.id);
    expect(stored?.recipients[0]).toMatchObject({ status: 'failed', reason: 'unknown_outcome' });
    expect(fake.log.sentAt.map(entry => entry.phone)).toEqual(['22222222']);
    expect(fake.log.notes).toContain('unknown_outcome');
  });
});
