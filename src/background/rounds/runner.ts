import { t } from '@extension/i18n';
import { db, productStore, roundsStore } from '@extension/storage';
import type { RoundId, RoundsState } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { agentService } from '../agents/instance';
import { addInboxItem, inboxItemId } from '../inbox/store';
import { createLogger } from '../log';
import { emitNotice } from '../notices';
import { services } from '../registry/services';
import { checkInDue, dueRound, localDay, localTime, slotKey } from './plan';
import { CHECKIN_PREFIX, mailAgent, mailRound, productPulse, stuckWork, unreadFrom } from './rounds';
import type { RoundDigest } from './rounds';

/**
 * Runs the rounds and makes the check-in offers (docs/growth-team.md, Part 4). One tick does at most one thing:
 * the one round that is due, or else one offer. A slot is marked before its round runs, so a background that
 * dies half-way never runs it twice, and rounds never pile up.
 */

const logger = createLogger('Rounds');
const STARTED_KEY = 'rounds-started';
const ATTENDED = new Set<string | undefined>([undefined, 'user', 'voice', 'whatsapp']);

let ticking: Promise<void> | null = null;

/** When this browser session started, kept for the session: quiet time is counted from then at the earliest. */
async function sessionStart(now: number): Promise<number> {
  const items: Record<string, unknown> = await chrome.storage.session.get(STARTED_KEY).catch(() => ({}));
  const stored = items[STARTED_KEY];
  if (typeof stored === 'number') return stored;
  await chrome.storage.session.set({ [STARTED_KEY]: now }).catch(() => undefined);
  return now;
}

/** One Inbox item per round. The product's notify channel gets a line only when something was flagged. */
async function post(round: RoundId, day: string, time: string, digest: RoundDigest): Promise<void> {
  if (digest.silent) return;
  await addInboxItem({
    source: 'system',
    externalId: digest.oncePerDay ? `round:${round}:${day}` : `round:${round}:${day}:${time}`,
    kind: 'result',
    title: digest.title,
    body: digest.lines.join('\n'),
    priority: digest.flagged.length ? 'high' : 'low',
  });
  if (!digest.flagged.length) return;
  const products = await productStore.all().catch(() => ({}));
  for (const flag of digest.flagged) {
    const notify = (products as Record<string, { notify: string | null }>)[flag.productId]?.notify;
    // WhatsApp is Ava's own line to the user. Slack would be a post, and nothing is posted in this phase.
    if (notify === 'whatsapp' || notify === 'both') {
      emitNotice({ kind: 'routine', title: flag.text, key: `round:${round}:${day}:${time}:${flag.productId}` });
    }
  }
}

/** Runs one round now and posts its digest. Used by the tick and by "run now". */
export async function runRound(round: RoundId, now = Date.now(), time = localTime(now)): Promise<RoundDigest> {
  const day = localDay(now);
  let digest: RoundDigest;
  if (round === 'pulse') {
    digest = await productPulse(time, { now: () => now });
  } else if (round === 'stuck') {
    const stuck = await stuckWork(time, now);
    await roundsStore.update(day, state => ({ ...state, findings: { ...state.findings, failed: stuck.failed } }));
    digest = stuck;
  } else {
    digest = await mailRound(time, day, now);
  }
  await post(round, day, time, digest);
  return digest;
}

/** Yesterday's offers nobody answered are closed, so they do not sit in the Inbox as things waiting on the user. */
async function closeOldOffers(day: string): Promise<void> {
  const before = await roundsStore.get();
  if (!before || before.day === day) return;
  for (const requestId of Object.keys(before.checkins?.open ?? {})) {
    await db.inbox.update(inboxItemId('system', requestId), { status: 'done', updatedAt: Date.now() }).catch(() => 0);
  }
}

async function inMeeting(now: number): Promise<boolean> {
  try {
    const reading = await services().calendar.reading(1);
    return reading.events.some(event => !event.allDay && event.start <= now && now < event.end);
  } catch {
    return false;
  }
}

/** When the user last gave a task themselves: typed, said, or sent from the phone. */
async function lastTaskAt(): Promise<number | null> {
  let latest: number | null = null;
  await db.threads.each(thread => {
    if (!ATTENDED.has(thread.origin)) return;
    const at = thread.runStartedAt ?? thread.createdAt;
    if (latest === null || at > latest) latest = at;
  });
  return latest;
}

/** What Ava could usefully do now, from what the rounds found; null when there is nothing worth offering. */
async function offerFor(
  state: RoundsState,
): Promise<{ title: string; open: RoundsState['checkins']['open'][string] } | null> {
  const agent = await mailAgent();
  if (agent) {
    // The Mail agent's latest answer today, if it gave one
    const answers = await db.inbox.where('agentId').equals(agent.id).toArray();
    const latest = answers.filter(item => item.kind === 'result').sort((a, b) => b.createdAt - a.createdAt)[0];
    const unread =
      latest && localDay(latest.createdAt) === state.day ? unreadFrom(`${latest.title}\n${latest.body}`) : null;
    if (unread !== 0) {
      return {
        title: unread ? t('checkin_mail', [String(unread)]) : t('checkin_mailPlain'),
        open: { kind: 'mail' },
      };
    }
  }
  const failed = state.findings.failed;
  if (failed.length) {
    return {
      title: t('checkin_retry', [String(failed.length), failed.map(item => item.title.slice(0, 40)).join(', ')]),
      open: { kind: 'retry', threadIds: failed.map(item => item.threadId) },
    };
  }
  return null;
}

async function checkIn(now: number, state: RoundsState): Promise<void> {
  const due = checkInDue({
    now,
    lastTaskAt: await lastTaskAt(),
    startedAt: await sessionStart(now),
    offersToday: state.checkins.offers,
    lastOfferAt: state.checkins.lastOfferAt,
    silenced: state.checkins.silenced,
    inMeeting: await inMeeting(now),
    roundDue: false,
  });
  if (!due.due) return;
  const offer = await offerFor(state);
  if (!offer) return;
  const requestId = `${CHECKIN_PREFIX}${state.day}:${state.checkins.offers + 1}`;
  // Counted before it is shown: two ticks at once never make two offers
  await roundsStore.update(state.day, current => ({
    ...current,
    checkins: {
      ...current.checkins,
      offers: current.checkins.offers + 1,
      lastOfferAt: now,
      open: { ...current.checkins.open, [requestId]: offer.open },
    },
  }));
  await addInboxItem({
    source: 'system',
    externalId: requestId,
    kind: 'approval',
    title: offer.title,
    body: t('checkin_body'),
    priority: 'normal',
    approval: { requestId, action: 'checkin' },
  });
  logger.info(`Offered a check-in (${offer.open.kind})`);
}

/**
 * The user's answer to an offer. Yes starts what was offered, with the user now there to watch. No is "not
 * today": no more offers until tomorrow.
 */
export async function answerCheckIn(requestId: string, approved: boolean, now = Date.now()): Promise<boolean> {
  const day = localDay(now);
  const state = await roundsStore.today(day);
  const offer = state.checkins.open[requestId];
  const open = { ...state.checkins.open };
  delete open[requestId];
  await roundsStore.update(day, current => ({
    ...current,
    checkins: { ...current.checkins, open, silenced: current.checkins.silenced || !approved },
  }));
  if (!approved || !offer) return true;
  try {
    if (offer.kind === 'mail') {
      const agent = await mailAgent();
      if (agent) {
        await agentService.requestRun(agent.id, {
          trigger: { type: 'manual', detail: 'check-in' },
          attended: true,
          tainted: false,
          queueIfBusy: true,
        });
      }
    } else {
      for (const threadId of offer.threadIds ?? []) await services().threads.retry(threadId);
    }
  } catch (error) {
    logger.warning(`The offered work could not start (${toAppError(error).kind})`);
  }
  return true;
}

/** One tick: the round that is due, or else an offer. */
export function tick(now = Date.now()): Promise<void> {
  ticking ??= (async () => {
    try {
      const day = localDay(now);
      await closeOldOffers(day);
      const state = await roundsStore.today(day);
      if (!state.enabled) return;
      const due = dueRound(now, state.ran);
      if (due) {
        // Marked first: a round that fails or is cut off is not run again for the same slot
        await roundsStore.update(day, current => ({
          ...current,
          ran: {
            ...current.ran,
            [slotKey(due.round, due.time)]: now,
            ...Object.fromEntries(due.skipped.map(time => [slotKey(due.round, time), 0])),
          },
        }));
        await runRound(due.round, now, due.time);
        return;
      }
      await checkIn(now, state);
    } catch (error) {
      logger.warning(`The rounds tick failed (${toAppError(error).kind})`, error);
    } finally {
      ticking = null;
    }
  })();
  return ticking;
}
