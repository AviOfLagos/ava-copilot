// Rounds and check-ins (docs/growth-team.md, Part 4): the tick that runs the one round that is due or makes one
// offer, the answer to an offer from the Inbox, and what Settings asks for (on or off, what ran today, run now).
import { z } from 'zod';
import { toAppError } from '@extension/shared';
import { db, roundsStore } from '@extension/storage';
import { registerApprovalHandler } from '../inbox/approvals';
import { jobs, registerJobHandler } from '../jobs/runner';
import { createLogger } from '../log';
import { answerOneOff, registerCommand, registerRecovery } from '../registry';
import { CHECKIN, dueRound, localDay, ROUNDS } from './plan';
import { CHECKIN_PREFIX } from './rounds';
import { answerCheckIn, runRound, tick } from './runner';

const logger = createLogger('Rounds');

export const ROUNDS_JOB = 'rounds_tick';
// Every five minutes: a round starts within five minutes of its time, and a missed one within five of the
// browser opening
const ROUNDS_CRON = '*/5 * * * *';

registerJobHandler(ROUNDS_JOB, async () => {
  await tick();
});

registerApprovalHandler(CHECKIN_PREFIX, (requestId, approved) => answerCheckIn(requestId, approved));

registerRecovery('rounds', async () => {
  // Scheduled once: scheduling again on every start of the background would keep pushing the next tick away
  const existing = await db.jobs.where('key').equals(ROUNDS_JOB).first();
  if (!existing || existing.cron !== ROUNDS_CRON || existing.status === 'failed') {
    await jobs.schedule({ kind: ROUNDS_JOB, key: ROUNDS_JOB, cron: ROUNDS_CRON });
  }
});

// ── What Settings asks for ────────────────────────────────────────────────────────────────────────

async function status() {
  const now = Date.now();
  const state = await roundsStore.today(localDay(now));
  return {
    enabled: state.enabled,
    rounds: ROUNDS.map(plan => ({
      id: plan.id,
      times: plan.times.map(time => ({ time, ranAt: state.ran[`${plan.id}|${time}`] ?? null })),
    })),
    next: dueRound(now, state.ran)?.round ?? null,
    offersToday: state.checkins.offers,
    offersLeft: Math.max(0, CHECKIN.perDay - state.checkins.offers),
    silenced: state.checkins.silenced,
  };
}

function command<S extends z.ZodType>(type: string, schema: S, run: (input: z.infer<S>) => Promise<unknown>): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      context.reply({ type: 'rounds_ok', requestId: context.requestId, result: await run(input) });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
    }
  });
}

command('rounds_status', z.object({}), () => status());
command('rounds_set_enabled', z.object({ enabled: z.boolean() }), async input => {
  await roundsStore.setEnabled(input.enabled);
  return status();
});
// The user's own click on "Run now": the round runs at once and its digest lands in the Inbox
command('rounds_run', z.object({ round: z.enum(['pulse', 'mail', 'stuck']) }), async input => {
  await runRound(input.round);
  return status();
});

// Only pages of the extension send these, never a web page and never an agent
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if (typeof message?.type !== 'string' || !message.type.startsWith('rounds_')) return;
  return answerOneOff(message, sendResponse);
});
