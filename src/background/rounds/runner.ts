import { t } from '@extension/i18n';
import { db, productStore, roundsStore } from '@extension/storage';
import type { RoundId, RoundsState } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { agentService } from '../agents/instance';
import { addInboxItem, inboxItemId } from '../inbox/store';
import { createLogger } from '../log';
import { emitNotice } from '../notices';
import { services } from '../registry/services';
import { CHECKIN, checkInDue, dueRound, localDay, localTime, slotKey } from './plan';
import { CHECKIN_PREFIX, MAIL_ROUND_TASK, mailAgent, mailRound, productPulse, stuckWork, unreadFrom } from './rounds';
import type { RoundDigest } from './rounds';

/**
 * Runs the rounds and makes the check-in offers (docs/growth-team.md, Part 4). One tick does at most one thing:
 * the one round that is due, or else one offer. A slot is marked before its round runs, so a background that
 * dies half-way never runs it twice, and rounds never pile up. A round that fails, or was cut off, says so in
 * the Inbox: nothing here ends in silence.
 */

const logger = createLogger('Rounds');
const STARTED_KEY = 'rounds-started';
const ATTENDED = new Set<string | undefined>([undefined, 'user', 'voice', 'whatsapp']);
// A slot that is running. Still this on a later tick: the background stopped half-way through the round.
const RUNNING = -1;
const SKIPPED = 0;

let ticking: Promise<void> | null = null;

const roundName = (round: RoundId) =>
  round === 'pulse' ? t('rounds_name_pulse') : round === 'mail' ? t('rounds_name_mail') : t('rounds_name_stuck');

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

/** Says that a round did not happen, and why, once for its slot. */
async function reportFailed(round: RoundId, day: string, time: string, why: string): Promise<void> {
  await addInboxItem({
    source: 'system',
    externalId: `round:${round}:${day}:${time}:failed`,
    kind: 'alert',
    title: t('rounds_failed_title', [roundName(round), time]),
    body: why,
    priority: 'normal',
  }).catch(error => logger.warning('Could not report a failed round', error));
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

const closeOffer = (requestId: string) =>
  db.inbox.update(inboxItemId('system', requestId), { status: 'done', updatedAt: Date.now() }).catch(() => 0);

// When the day turns, yesterday's offers nobody answered are closed before they are forgotten, so they do not
// sit in the Inbox as buttons that do nothing
roundsStore.setNewDayHandler(async yesterday => {
  for (const requestId of Object.keys(yesterday.checkins?.open ?? {})) await closeOffer(requestId);
});

/** In a meeting now. When the calendar cannot be read at all, that counts as yes: no offer over a meeting. */
async function inMeeting(now: number): Promise<boolean> {
  try {
    const reading = await services().calendar.reading(1);
    return reading.events.some(event => !event.allDay && event.start <= now && now < event.end);
  } catch {
    return true;
  }
}

/**
 * When the user last worked with Ava themselves: the newest change to a chat they started (typed, said, or
 * sent from the phone). A follow-up in an old chat counts, which the chat's creation time would miss.
 */
async function lastTaskAt(): Promise<number | null> {
  const newest = await db.threads
    .orderBy('updatedAt')
    .reverse()
    .filter(thread => ATTENDED.has(thread.origin))
    .first();
  return newest ? Math.max(newest.updatedAt, newest.runStartedAt ?? 0) : null;
}

type Offer = RoundsState['checkins']['open'][string];

/** The chats among these that still stand failed for a passing reason: only those may be tried again. */
async function stillFailed(threadIds: string[]): Promise<string[]> {
  const threads = await db.threads.bulkGet(threadIds);
  return threads
    .filter(thread => thread?.status === 'error' && thread.failure?.cls === 'temporary' && !thread.failure.retryAt)
    .map(thread => thread!.id);
}

/** What Ava could usefully do now, from what the rounds found; null when there is nothing worth offering. */
async function offerFor(state: RoundsState): Promise<{ title: string; open: Offer } | null> {
  const agent = await mailAgent();
  if (agent) {
    // The Mail agent's latest answer today, if it gave one
    const answers = await db.inbox.where('agentId').equals(agent.id).toArray();
    const latest = answers.filter(item => item.kind === 'result').sort((a, b) => b.createdAt - a.createdAt)[0];
    const unread =
      latest && localDay(latest.createdAt) === state.day ? unreadFrom(`${latest.title}\n${latest.body}`) : null;
    // With the count known to be none there is no mail to sort; with no count, the offer names none
    if (unread !== 0) {
      return {
        title: unread ? t('checkin_mail', [String(unread)]) : t('checkin_mailPlain'),
        open: { kind: 'mail' },
      };
    }
  }
  const failed = await stillFailed(state.findings.failed.map(item => item.threadId));
  if (failed.length) {
    const titles = state.findings.failed.filter(item => failed.includes(item.threadId)).map(item => item.title);
    return {
      title: t('checkin_retry', [String(failed.length), titles.map(title => title.slice(0, 40)).join(', ')]),
      open: { kind: 'retry', threadIds: failed },
    };
  }
  return null;
}

async function checkIn(now: number, state: RoundsState): Promise<void> {
  // The cheap rules first: nothing is read from the database or the calendar outside the hours, after "not
  // today", or once the day's offers are spent
  const hour = new Date(now).getHours();
  if (hour < CHECKIN.fromHour || hour >= CHECKIN.toHour) return;
  if (state.checkins.silenced || state.checkins.offers >= CHECKIN.perDay) return;
  const due = checkInDue({
    now,
    lastTaskAt: await lastTaskAt(),
    startedAt: await sessionStart(now),
    offersToday: state.checkins.offers,
    lastOfferAt: state.checkins.lastOfferAt,
    silenced: state.checkins.silenced,
    inMeeting: await inMeeting(now),
    // This runs only when no round was due on this tick
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
 * today": no more offers until tomorrow. An offer is taken once: a second click, or an answer to an offer that
 * is no longer open, starts nothing and silences nothing.
 */
export async function answerCheckIn(requestId: string, approved: boolean, now = Date.now()): Promise<boolean> {
  const day = localDay(now);
  let offer: Offer | undefined;
  await roundsStore.update(day, current => {
    // Taken out in the same step that reads it: two answers at once cannot both find it
    offer = current.checkins.open[requestId];
    if (!offer) return current;
    const open = { ...current.checkins.open };
    delete open[requestId];
    return { ...current, checkins: { ...current.checkins, open, silenced: current.checkins.silenced || !approved } };
  });
  await closeOffer(requestId);
  if (!approved || !offer) return true;
  try {
    if (offer.kind === 'mail') {
      const agent = await mailAgent();
      if (!agent) throw new Error(t('rounds_mail_noAgent'));
      await agentService.requestRun(agent.id, {
        trigger: { type: 'manual', detail: 'check-in' },
        attended: true,
        tainted: false,
        task: MAIL_ROUND_TASK,
        // One run per offer, whatever happens to the click
        firingKey: requestId,
        queueIfBusy: true,
      });
    } else {
      // Only what still stands failed: a chat the user tried again meanwhile is left alone
      for (const threadId of await stillFailed(offer.threadIds ?? [])) await services().threads.retry(threadId);
    }
  } catch (error) {
    // The user said yes: they are told when it could not start
    logger.warning(`The offered work could not start (${toAppError(error).kind})`);
    await addInboxItem({
      source: 'system',
      externalId: `${requestId}:failed`,
      kind: 'alert',
      title: t('checkin_failed'),
      body: toAppError(error).message,
      priority: 'normal',
    }).catch(() => undefined);
  }
  return true;
}

/** One tick: the round that is due, or else an offer. */
export function tick(now = Date.now()): Promise<void> {
  ticking ??= (async () => {
    try {
      const day = localDay(now);
      let state = await roundsStore.today(day);
      if (!state.enabled) return;

      // A slot still marked as running was cut off (the background stopped): say so once, and do not run it again
      const cut = Object.entries(state.ran).filter(([, at]) => at === RUNNING);
      if (cut.length) {
        state = await roundsStore.update(day, current => ({
          ...current,
          ran: { ...current.ran, ...Object.fromEntries(cut.map(([slot]) => [slot, SKIPPED])) },
        }));
        for (const [slot] of cut) {
          const [round, time] = slot.split('|') as [RoundId, string];
          await reportFailed(round, day, time, t('rounds_failed_cut'));
        }
      }

      const due = dueRound(now, state.ran);
      if (due) {
        const slot = slotKey(due.round, due.time);
        // Marked first: a round that fails or is cut off is not run again for the same slot
        await roundsStore.update(day, current => ({
          ...current,
          ran: {
            ...current.ran,
            [slot]: RUNNING,
            ...Object.fromEntries(due.skipped.map(time => [slotKey(due.round, time), SKIPPED])),
          },
        }));
        try {
          await runRound(due.round, now, due.time);
        } catch (error) {
          logger.warning(`The ${due.round} round failed (${toAppError(error).kind})`, error);
          await reportFailed(due.round, day, due.time, toAppError(error).message);
        }
        await roundsStore.update(day, current => ({ ...current, ran: { ...current.ran, [slot]: now } }));
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
