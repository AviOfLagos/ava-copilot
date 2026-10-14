import { countOneMore, nextWait, remainingToday } from '@extension/storage';
import type { BulkDailyCount, BulkRecipient, BulkRun } from '@extension/storage';
import { getRun, updateRun } from './state';

/**
 * Moves an approved bulk run forward, one message at a time, with the random pauses and cooldowns of its
 * settings. Everything it needs from outside (time, the tab, sending, scheduling) comes in `deps`, so the pacing
 * is tested with a fake clock. Waits up to INLINE_WAIT_MS happen here; anything longer is a job at `nextAt`, so
 * the run survives the background stopping. A run only moves while its status is "running": pause, stop and a
 * closed tab all end the loop at the next check, and a message cut off mid-send is never sent again.
 */

// Longer waits than this are a scheduled job, not a timer
export const INLINE_WAIT_MS = 20_000;
// One pass works at most this long before handing over to a job
export const SLICE_MS = 4 * 60_000;

export type SendOutcome =
  | { status: 'sent' }
  | { status: 'skipped' | 'failed'; reason: string }
  // Nothing was sent: the tab went away or signed out before the message could go
  | { status: 'pending'; reason: 'tab_closed' | 'logged_out' };

export type TabCheck = { ok: true; tabId: number } | { ok: false; reason: 'tab_closed' | 'logged_out' };

export type BulkNote = 'tab_closed' | 'logged_out' | 'daily_cap' | 'done' | 'unknown_outcome';

export interface BulkDeps {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  random: () => number;
  // The local day, "YYYY-MM-DD"
  today: () => string;
  // The next local midnight after now, for a run paused by the daily cap
  nextDayAt: () => number;
  checkTab: () => Promise<TabCheck>;
  send: (tabId: number, recipient: BulkRecipient, run: BulkRun, signal: AbortSignal) => Promise<SendOutcome>;
  scheduleAt: (runId: string, at: number) => Promise<void>;
  note: (run: BulkRun, note: BulkNote) => Promise<void>;
  getDaily: () => Promise<BulkDailyCount>;
  setDaily: (count: BulkDailyCount) => Promise<void>;
}

// Runs being moved by this background right now: a second pass for the same run returns at once
const active = new Set<string>();

export function isAdvancing(runId: string): boolean {
  return active.has(runId);
}

/**
 * A message marked "sending" by a background that then stopped may or may not have gone out. It is never sent
 * again: it is marked failed with an unknown outcome, and the user is told to check WhatsApp.
 */
export async function settleInterrupted(runId: string, deps: Pick<BulkDeps, 'note' | 'now'>): Promise<void> {
  let changed = false;
  const run = await updateRun(runId, current => {
    const sending = current.recipients.filter(recipient => recipient.status === 'sending');
    if (sending.length === 0) return null;
    changed = true;
    for (const recipient of sending) {
      recipient.status = 'failed';
      recipient.reason = 'unknown_outcome';
      recipient.at = deps.now();
    }
    return current;
  });
  if (changed && run) await deps.note(run, 'unknown_outcome');
}

function finished(run: BulkRun): boolean {
  return !run.recipients.some(recipient => recipient.status === 'pending' || recipient.status === 'sending');
}

/** Moves a run forward until it waits for longer than a timer should, pauses, or ends. */
export async function advanceRun(runId: string, deps: BulkDeps, signal: AbortSignal): Promise<void> {
  if (active.has(runId)) return;
  active.add(runId);
  try {
    await settleInterrupted(runId, deps);
    const started = deps.now();
    for (;;) {
      if (signal.aborted) return;
      let run = await getRun(runId);
      if (!run) return;

      // The daily cap paused it: a new day lets it go on
      if (run.status === 'paused' && run.note === 'daily_cap') {
        const daily = await deps.getDaily();
        if (remainingToday(daily, deps.today(), run.settings.dailyCap) <= 0) {
          await deps.scheduleAt(runId, deps.nextDayAt());
          return;
        }
        run = await updateRun(runId, current => ({ ...current, status: 'running', note: '' }));
        if (!run) return;
      }
      if (run.status !== 'running') return;

      const index = run.recipients.findIndex(recipient => recipient.status === 'pending');
      if (index === -1 || finished(run)) {
        const done = await updateRun(runId, current =>
          current.status === 'running' ? { ...current, status: 'done', nextAt: null, note: '' } : null,
        );
        if (done?.status === 'done') await deps.note(done, 'done');
        return;
      }

      const now = deps.now();
      if (run.nextAt !== null && run.nextAt > now) {
        const wait = run.nextAt - now;
        if (wait > INLINE_WAIT_MS || now - started + wait > SLICE_MS) {
          await deps.scheduleAt(runId, run.nextAt);
          return;
        }
        await deps.sleep(wait, signal);
        continue;
      }

      const daily = await deps.getDaily();
      if (remainingToday(daily, deps.today(), run.settings.dailyCap) <= 0) {
        const paused = await updateRun(runId, current =>
          current.status === 'running' ? { ...current, status: 'paused', note: 'daily_cap' } : null,
        );
        if (paused?.status === 'paused') {
          await deps.note(paused, 'daily_cap');
          await deps.scheduleAt(runId, deps.nextDayAt());
        }
        return;
      }

      const tab = await deps.checkTab();
      if (!tab.ok) {
        const waiting = await updateRun(runId, current =>
          current.status === 'running' ? { ...current, status: 'waiting_tab', note: tab.reason } : null,
        );
        if (waiting?.status === 'waiting_tab') await deps.note(waiting, tab.reason);
        return;
      }

      // Marked before the send: if the background stops in the middle, this message is never sent twice
      const marked = await updateRun(runId, current => {
        if (current.status !== 'running' || current.recipients[index]?.status !== 'pending') return null;
        current.recipients[index].status = 'sending';
        return current;
      });
      if (!marked || marked.recipients[index].status !== 'sending') continue;

      let outcome: SendOutcome;
      try {
        outcome = await deps.send(tab.tabId, marked.recipients[index], marked, signal);
      } catch {
        outcome = { status: 'failed', reason: 'unknown_outcome' };
      }

      if (outcome.status === 'pending') {
        const waiting = await updateRun(runId, current => {
          current.recipients[index].status = 'pending';
          if (current.status === 'running') {
            current.status = 'waiting_tab';
            current.note = outcome.reason;
          }
          return current;
        });
        if (waiting?.status === 'waiting_tab') await deps.note(waiting, outcome.reason);
        return;
      }

      if (outcome.status === 'sent') {
        await deps.setDaily(countOneMore(await deps.getDaily(), deps.today()));
      }
      const after = deps.now();
      const updated = await updateRun(runId, current => {
        const recipient = current.recipients[index];
        recipient.status = outcome.status as BulkRecipient['status'];
        recipient.reason = outcome.status === 'sent' ? '' : (outcome as { reason: string }).reason;
        recipient.at = after;
        if (outcome.status === 'sent') {
          current.sinceCooldown += 1;
          const wait = nextWait(current.settings, current.sinceCooldown, deps.random);
          if (wait.cooldown) current.sinceCooldown = 0;
          current.nextAt = after + wait.ms;
        } else {
          // Nothing went out, but the tab moved: keep the shortest gap before the next one
          current.nextAt = after + current.settings.delayMinSec * 1000;
        }
        return current;
      });
      if (outcome.status === 'failed' && outcome.reason === 'unknown_outcome' && updated) {
        await deps.note(updated, 'unknown_outcome');
      }
    }
  } finally {
    active.delete(runId);
  }
}
