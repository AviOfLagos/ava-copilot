import { t } from '@extension/i18n';
import { db, growthStore, productStore, shiftDay, utcDay } from '@extension/storage';
import type { ProductProfile, RoundsState } from '@extension/storage';
import { AppError, toAppError } from '@extension/shared';
import { agentService } from '../agents/instance';
import { stoppedThreads, waitingItems } from '../brief/brief';
import { inboxDecisions, waitingRuns } from '../brief/manager';
import { collectProduct, markNoticed } from '../growth/collect';
import { queryMetric } from '../growth/query';
import { reasonText } from '../growth/reasons';
import { createLogger } from '../log';
import { whatChanged } from './plan';
import { slackCounts } from './slack';
import type { SlackCounts } from './slack';

/**
 * The three rounds (docs/growth-team.md, Part 4): read-only sweeps that each end in one short digest.
 *
 * - Product pulse: each product's numbers and its Slack notification counts, and what changed. Plain code.
 * - Stuck work: what is failed, waiting or open, and on whom. Plain code.
 * - Mail: the Mail agent reads the inbox in the agents' own window; its answer is the digest.
 *
 * Nothing here sends, posts or grants anything.
 */

const logger = createLogger('Rounds');

export interface RoundDigest {
  title: string;
  lines: string[];
  // What moved enough to be worth a line on the product's notify channel
  flagged: { productId: string; text: string }[];
  // Nothing to say and nothing to post (the mail round, whose agent posts its own answer)
  silent?: boolean;
  // Said at most once a day, however many slots find the same thing (mail that cannot be read)
  oncePerDay?: boolean;
}

const amount = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));

// ── Product pulse ─────────────────────────────────────────────────────────────────────────────────

export const PULSE_METRICS = ['signups', 'waitlist', 'access_requests', 'feedback'] as const;

const metricName = (metric: string): string => {
  const known: Record<string, string> = {
    signups: t('rounds_metric_signups'),
    waitlist: t('rounds_metric_waitlist'),
    access_requests: t('rounds_metric_access_requests'),
    feedback: t('rounds_metric_feedback'),
  };
  return known[metric] ?? metric.replace(/^slack_/, 'Slack: ').replace(/_/g, ' ');
};

export interface PulseDeps {
  now?: () => number;
  collect?: typeof collectProduct;
  slack?: (profile: ProductProfile, since: number) => Promise<SlackCounts>;
  products?: () => Promise<ProductProfile[]>;
}

/**
 * One metric's lines for the pulse. Two comparisons, both plain arithmetic:
 * - the last whole day against the seven days before it: flagged up or down;
 * - today so far against the seven days before it: flagged only when it is already up. A day that is not over
 *   always looks "down", so it is never flagged down.
 */
async function metricLines(productId: string, metric: string, today: string) {
  const yesterday = shiftDay(today, -1);
  const answer = await queryMetric(growthStore, { productId, metric, from: shiftDay(today, -8), to: today });
  const value = (day: string) => answer.byDay.find(entry => entry.date === day)?.value ?? null;
  const week = (last: string) => Array.from({ length: 7 }, (_, index) => value(shiftDay(last, -(index + 1))));
  const name = metricName(metric);
  const soFar = value(today);
  const whole = value(yesterday);
  const lines: string[] = [];
  const flags: string[] = [];

  if (soFar === null && whole === null) {
    const reason = answer.byDay.find(entry => entry.date === today)?.reason ?? answer.source?.reason ?? null;
    const why = reason ? reasonText(reason) : '';
    return { lines: [t('rounds_pulse_noReading', [name, why])], flags, none: why };
  }
  const wholeDay = whatChanged(whole, week(yesterday));
  // A "yesterday" that was read before it ended is not a whole day: nothing is flagged on it
  const wholeIsFinal = !answer.unfinished.includes(yesterday);
  if (wholeIsFinal && wholeDay.flagged && whole !== null && wholeDay.average !== null) {
    flags.push(
      t(wholeDay.direction === 'up' ? 'rounds_pulse_flagUp' : 'rounds_pulse_flagDown', [
        name,
        amount(whole),
        amount(wholeDay.average),
        t('rounds_pulse_yesterday'),
      ]),
    );
  }
  const partDay = whatChanged(soFar, week(today));
  if (partDay.flagged && partDay.direction === 'up' && soFar !== null && partDay.average !== null) {
    flags.push(t('rounds_pulse_flagUp', [name, amount(soFar), amount(partDay.average), t('rounds_pulse_todaySoFar')]));
  }
  const average = partDay.average ?? wholeDay.average;
  lines.push(
    t('rounds_pulse_metric', [
      name,
      soFar === null ? t('growth_noReading') : amount(soFar),
      whole === null ? t('growth_noReading') : amount(whole),
      average === null ? t('rounds_pulse_noAverage') : amount(average),
    ]),
  );
  return { lines, flags };
}

/** The product pulse: for every product with numbers to read, counts and what changed. */
export async function productPulse(time: string, deps: PulseDeps = {}): Promise<RoundDigest> {
  const now = deps.now?.() ?? Date.now();
  const today = utcDay(now);
  const digest: RoundDigest = { title: t('rounds_pulse_title', [time]), lines: [], flagged: [] };
  const products = await (deps.products ?? (async () => Object.values(await productStore.all())))();
  const readable = products.filter(profile => profile.agentApi || profile.slackChannels.some(channel => channel.id));
  // With no product to read there is no pulse to take: nothing is posted
  if (!readable.length) return { ...digest, silent: true };

  for (const profile of readable) {
    const productId = profile.workspaceId;
    const flags: string[] = [];
    // The days are UTC days, as the product counts them
    digest.lines.push(`${profile.name || productId} (UTC)`);

    if (profile.agentApi) {
      // Fresh numbers first; a failed read leaves "no reading" behind, never a zero
      const outcome = await (deps.collect ?? collectProduct)(profile).catch(error => {
        logger.warning(`The pulse could not collect ${productId} (${toAppError(error).kind})`);
        return null;
      });
      // The pulse says why itself, so the collector's own notice is not sent on top of it
      if (outcome?.notice) await markNoticed(productId, outcome.source, outcome.notice.reason).catch(() => undefined);
      const parts = [];
      for (const metric of PULSE_METRICS) parts.push(await metricLines(productId, metric, today));
      const reasons = new Set(parts.map(part => ('none' in part ? part.none : null)));
      if (reasons.size === 1 && !reasons.has(null)) {
        // Nothing could be read, all for one reason: said once, not once per number
        digest.lines.push(`  ${t('rounds_pulse_noReading', [t('growth_title'), [...reasons][0] ?? ''])}`);
      } else {
        for (const part of parts) {
          digest.lines.push(...part.lines.map(line => `  ${line}`));
          flags.push(...part.flags);
        }
      }
    }

    if (profile.slackChannels.some(channel => channel.id)) {
      const slack = await (deps.slack ?? slackCounts)(profile, Date.parse(`${today}T00:00:00Z`)).catch(
        (): SlackCounts => ({ ok: false, reason: 'failed', detail: 'Slack could not be read.' }),
      );
      if (!slack.ok) {
        digest.lines.push(`  ${t('rounds_pulse_slackOff', [slackReason(slack.reason)])}`);
      } else {
        const kinds = Object.entries(slack.counts).sort((a, b) => b[1] - a[1]);
        // Kept as numbers too, so tomorrow's pulse has something to compare with
        for (const [kind, count] of kinds) {
          await growthStore.record({
            ok: true,
            productId,
            source: 'slack',
            metric: `slack_${kind}`,
            date: today,
            total: count,
            readAt: now,
          });
          const part = await metricLines(productId, `slack_${kind}`, today);
          flags.push(...part.flags);
        }
        const counted = kinds.length
          ? kinds.map(([kind, count]) => `${kind.replace(/_/g, ' ')} ${count}`).join(', ')
          : '0';
        digest.lines.push(`  ${t(slack.partial ? 'rounds_pulse_slackAtLeast' : 'rounds_pulse_slack', [counted])}`);
      }
    }
    for (const flag of flags) digest.flagged.push({ productId, text: `${profile.name || productId}: ${flag}` });
  }
  if (digest.flagged.length) digest.lines.unshift(...digest.flagged.map(flag => flag.text), '');
  return digest;
}

const SLACK_REASONS: Record<string, string> = {
  no_channels: 'rounds_slack_no_channels',
  not_connected: 'rounds_slack_not_connected',
  needs_sign_in: 'rounds_slack_needs_sign_in',
  asks_first: 'rounds_slack_asks_first',
  no_read_tool: 'rounds_slack_no_read_tool',
  failed: 'rounds_slack_failed',
};

/** Why Slack was not read, in the user's language. */
const slackReason = (reason: string): string =>
  t((SLACK_REASONS[reason] ?? 'rounds_slack_failed') as Parameters<typeof t>[0]);

// ── Stuck work ────────────────────────────────────────────────────────────────────────────────────

/** Stuck work: what waits on the user and what failed, each thing once, most urgent first. */
export async function stuckWork(
  time: string,
  now = Date.now(),
): Promise<RoundDigest & { failed: RoundsState['findings']['failed'] }> {
  const threads = await db.threads.toArray();
  const agents = await db.agents.toArray();
  const chatIds = new Set(threads.map(thread => thread.id));
  // An offer Ava made is not something that blocks: it is left out. So is an item whose chat is gone.
  const inbox = (await inboxDecisions()).filter(item => {
    if (item.approval?.requestId.startsWith(CHECKIN_PREFIX)) return false;
    const chat = item.approval?.requestId.startsWith('thread:') ? item.approval.requestId.slice(7) : null;
    return chat === null || chatIds.has(chat);
  });
  const stopped = stoppedThreads(threads, now);
  const items = waitingItems({
    waiting: threads.filter(thread => thread.status === 'waiting_confirm' && !thread.archived),
    stopped,
    inbox,
    runs: await waitingRuns(),
    agentNames: Object.fromEntries(agents.map(agent => [agent.id, agent.name])),
  });

  const kindText = {
    approval: t('rounds_stuck_approval'),
    needs_user: t('rounds_stuck_needsUser'),
    decision: t('rounds_stuck_decision'),
    failed: t('rounds_stuck_failed'),
  };
  const lines = items.length
    ? items
        .slice(0, 12)
        .map(
          item =>
            `${item.title.slice(0, 80)}: ${kindText[item.kind]}${item.detail ? ` (${item.detail.slice(0, 120)})` : ''}`,
        )
    : [t('rounds_stuck_none')];
  if (items.length > 12) lines.push(t('rounds_stuck_more', [String(items.length - 12)]));
  return {
    title: t('rounds_stuck_title', [time]),
    lines,
    flagged: [],
    // What trying again could fix: tasks that failed for a passing reason and are no longer being retried
    failed: stopped
      .filter(thread => thread.failure?.cls === 'temporary' && thread.activeTask)
      .slice(0, 3)
      .map(thread => ({ threadId: thread.id, title: thread.title || 'Untitled' })),
  };
}

// ── Mail ──────────────────────────────────────────────────────────────────────────────────────────

export const CHECKIN_PREFIX = 'checkin:';
const RECENT_MS = 60 * 60 * 1000;

// What the Mail agent is asked for on a round: a count first, so the digest can be read at a glance
export const MAIL_ROUND_TASK =
  'This is a mail round. Read the unread email in the inbox. Start your answer with one line in exactly this form: "N unread: X need you, Y drafts ready." Then the triage, shortest first. Draft replies where one is needed and leave them in Drafts. Send nothing, archive nothing, delete nothing.';

/** The Mail agent of this install, if one was made from the template and is on. */
export async function mailAgent() {
  const agents = await db.agents.toArray();
  return agents.find(agent => agent.template === 'team_mail' && agent.enabled) ?? null;
}

/**
 * The mail round: asks the Mail agent for a run. Its answer lands in the Inbox as the round's digest, so the
 * round itself posts nothing unless mail could not be read.
 */
export async function mailRound(
  time: string,
  day: string,
  now = Date.now(),
  requestRun: typeof agentService.requestRun = (id, request) => agentService.requestRun(id, request),
): Promise<RoundDigest> {
  const title = t('rounds_mail_title', [time]);
  const agent = await mailAgent();
  if (!agent) return { title, lines: [t('rounds_mail_noAgent')], flagged: [], oncePerDay: true };
  const last = (await agentService.runsOf(agent.id).catch(() => []))[0];
  if (last && now - last.startedAt < RECENT_MS) return { title, lines: [], flagged: [], silent: true };
  try {
    await requestRun(agent.id, {
      trigger: { type: 'schedule', detail: `mail round ${time}` },
      attended: false,
      tainted: false,
      task: MAIL_ROUND_TASK,
      // One run per slot, however often the tick asks
      firingKey: `round:mail:${day}:${time}`,
      queueIfBusy: true,
    });
    return { title, lines: [], flagged: [], silent: true };
  } catch (error) {
    const reason = error instanceof AppError ? error.message : toAppError(error).message;
    return { title, lines: [t('rounds_mail_failed', [reason])], flagged: [], oncePerDay: true };
  }
}

/** The unread count the Mail agent's latest answer starts with, if it says one. */
export function unreadFrom(text: string | null | undefined): number | null {
  const match = /(\d{1,5})\s+unread/i.exec(text ?? '');
  return match ? Number(match[1]) : null;
}
