import { t } from '@extension/i18n';
import type {
  AgentProfile,
  ConfirmRequest,
  FailureClass,
  InboxItem,
  JobRecord,
  ThreadErrorKind,
  ThreadFailure,
  ThreadRecord,
} from '@extension/storage';
import { createLogger } from '../log';
import type { Notice } from '../notices';
import { classify, MAX_AUTO_TRIES, nextRetryAt } from './classify';
import type { FailureCode } from './classify';

/**
 * What happens when a run ends with an error (docs/growth-team.md, Part 2): never silence. A temporary failure
 * is queued to try again after 1, 5 and 15 minutes, by the job runner, as the same task. When the tries are used
 * up, or when trying again cannot help, the user is told once: one Inbox item, and one WhatsApp line after a
 * temporary failure's last try. A step only the user can do (a sign-in, a CAPTCHA, a code) is one Inbox item
 * while the chat waits for it.
 *
 * The thread manager calls in here when a run ends; the retry job calls back into the thread manager. Everything
 * it touches is passed in, so tests run it on plain fakes.
 */

const logger = createLogger('Retry');

export const THREAD_RETRY_JOB = 'thread.retry';
// Every job of a chat starts with this, so they can all be dropped at once
export const retryJobPrefix = (threadId: string): string => `thread-retry:${threadId}:`;
// One job per try and per wait, not one per chat: the job runner writes "done" on a job after its handler
// returns, and a job queued meanwhile under the same key (the next try, the same try a little later) would be
// overwritten by that write
export const retryJobKey = (threadId: string, triesSoFar: number, waits = 0): string =>
  `${retryJobPrefix(threadId)}${triesSoFar}:${waits}`;
// A try that cannot start (every slot busy, its tab in use) waits and looks again this often, for this long:
// with three agents at work a full house is normal, and their own runs wait as long for a slot
const START_AGAIN_MS = 30_000;
const MAX_START_WAITS = 60;
// An agent over its day's money is looked at again each morning, for at most a week
const MAX_POSTPONED = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const INBOX_SOURCE = 'system';
// One per task and per round: the user's own Retry or Continue starts a new round, which may get stuck anew
export const stuckItemId = (thread: Pick<ThreadRecord, 'id' | 'taskRunId' | 'retryRound'>): string =>
  `${INBOX_SOURCE}|stuck:${thread.taskRunId ?? thread.id}:${thread.retryRound ?? 0}`;
const needsExternalId = (thread: Pick<ThreadRecord, 'id' | 'taskRunId'>, kind: string): string =>
  `needs:${thread.taskRunId ?? thread.id}:${kind}`;

// The steps only the user can do, and what the Inbox calls them
const NEEDS_TITLES = {
  login: 'retry_needs_login',
  captcha: 'retry_needs_captcha',
  code: 'retry_needs_code',
  cap: 'retry_needs_cap',
} as const;
type NeedsKind = keyof typeof NEEDS_TITLES;
const isNeedsKind = (kind: string): kind is NeedsKind => kind in NEEDS_TITLES;

export interface RetryPayload {
  threadId: string;
  taskRunId: string | null;
  // Which try this is (the chat's autoTries when it was queued): a job left over from an earlier try does nothing
  tries: number;
  // How often this try waited for a free slot, and how many mornings for its agent's money
  waits?: number;
  postponed?: number;
}

export interface RunEndingDeps {
  schedule(request: { kind: string; key: string; runAt: number; payload: RetryPayload }): Promise<unknown>;
  // Drops every job whose key starts with the prefix
  cancelJobs(prefix: string): Promise<void>;
  inbox(draft: {
    source: string;
    externalId: string;
    kind: InboxItem['kind'];
    title: string;
    body: string;
    priority: InboxItem['priority'];
    workspaceId: string | null;
    agentId: string | null;
    approval: InboxItem['approval'];
  }): Promise<unknown>;
  inboxItem(id: string): Promise<InboxItem | undefined>;
  // Marks an Inbox item done; a missing one is fine
  settleInbox(id: string): Promise<unknown>;
  // Puts a done Inbox item back to unread
  reopenInbox(id: string): Promise<unknown>;
  // Whether the run that owns an agent's chat is still open and following it
  ownerFollows(thread: ThreadRecord): Promise<boolean>;
  notice(notice: Notice): void;
  // A line in the chat itself
  note(threadId: string, text: string): Promise<unknown>;
  agent(agentId: string): Promise<AgentProfile | undefined>;
  // What an agent spent today, in US dollars
  agentSpentUsd(agentId: string): Promise<number>;
  now(): number;
}

// What the retry job needs of the thread manager
export interface RetryThreads {
  thread(threadId: string): Promise<ThreadRecord | undefined>;
  // Picks the task up again from its transcript
  resume(threadId: string): Promise<void>;
  // Moves the queued try (the day's money is spent: tomorrow)
  postpone(threadId: string, retryAt: number): Promise<void>;
  // The queued try could not start: the thread is told to stop trying and report
  giveUp(threadId: string): Promise<void>;
  // Nobody follows the chat any more: the try is dropped without a word (its owner reported)
  drop(threadId: string): Promise<void>;
}

export interface Ending {
  failure: ThreadFailure;
  autoTries: number;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const sentence = (text: string): string => {
  const clean = text.replace(/\s+/g, ' ').trim();
  return !clean || /[.!?…]$/.test(clean) ? clean : `${clean}.`;
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** What the user is asked to do, by class and cause. */
export function needOf(cls: FailureClass, code: FailureCode | null | undefined): string {
  if (cls === 'temporary') return t('retry_need_temporary', [String(MAX_AUTO_TRIES)]);
  if (cls === 'cannot') return t('retry_need_cannot');
  if (code === 'auth' || code === 'forbidden') return t('retry_need_key');
  if (code === 'model_missing') return t('retry_need_model');
  if (code === 'billing') return t('retry_need_billing');
  if (code === 'debugger_closed') return t('retry_need_debugger');
  if (code === 'extension_conflict') return t('retry_need_extension');
  return t('retry_need_user');
}

export class RunEndings {
  constructor(private readonly deps: RunEndingDeps) {}

  /** What the Inbox and WhatsApp call the task: the agent's name for an agent's run, else the chat's title. */
  private async taskName(thread: ThreadRecord): Promise<string> {
    const agent = thread.agentId ? await this.deps.agent(thread.agentId).catch(() => undefined) : undefined;
    return clip(agent?.name || thread.title || thread.activeTask || t('retry_untitled'), 80);
  }

  /**
   * A run ended with an error. A temporary failure with tries left is queued again; anything else is reported,
   * once.
   *
   * @returns What the thread keeps: the class, the queued try if any, and how many automatic tries are used
   */
  async ended(
    thread: ThreadRecord,
    error: { kind: ThreadErrorKind; message: string },
    code: FailureCode | null | undefined,
    // The step error behind "too many failures", when the executor kept it: it says more than the count
    detail?: string | null,
  ): Promise<Ending> {
    const cls = classify(error.kind, code);
    const tries = thread.autoTries ?? 0;
    const now = this.deps.now();
    const why = detail?.trim() || error.message;
    const retryAt = cls === 'temporary' ? nextRetryAt(tries, now) : null;
    if (retryAt !== null) {
      try {
        await this.deps.schedule({
          kind: THREAD_RETRY_JOB,
          key: retryJobKey(thread.id, tries + 1),
          runAt: retryAt,
          payload: { threadId: thread.id, taskRunId: thread.taskRunId ?? null, tries: tries + 1 },
        });
      } catch (problem) {
        // Not queued: saying so beats a chat that claims it will try again
        logger.error('Could not queue a try', problem);
        await this.report(thread, cls, why, code);
        return { failure: { cls, retryAt: null, reported: true }, autoTries: tries };
      }
      const minutes = Math.round((retryAt - now) / 60_000);
      await this.deps
        .note(thread.id, t('retry_queued', [String(minutes), String(tries + 1), String(MAX_AUTO_TRIES)]))
        .catch(problem => logger.warning('Could not note the queued try', problem));
      return { failure: { cls, retryAt, reported: false }, autoTries: tries + 1 };
    }
    await this.report(thread, cls, why, code);
    return { failure: { cls, retryAt: null, reported: true }, autoTries: tries };
  }

  /**
   * Tells the user a task is stuck: one Inbox item, and one WhatsApp line when it gave up after its tries.
   * Called again for the same task, it does nothing: there is never a second one.
   */
  async report(
    thread: ThreadRecord,
    cls: FailureClass,
    reason: string,
    code?: FailureCode | null,
    // The chat's status does not change with this report, so nothing else will tell a chat started on WhatsApp
    options: { direct?: boolean } = {},
  ): Promise<void> {
    try {
      const id = stuckItemId(thread);
      if (await this.deps.inboxItem(id)) return;
      const task = await this.taskName(thread);
      const why = sentence(clip(reason.replace(/\s+/g, ' ').trim(), 300));
      const need = needOf(cls, code);
      await this.deps.inbox({
        source: INBOX_SOURCE,
        externalId: id.slice(INBOX_SOURCE.length + 1),
        kind: 'alert',
        title: t('retry_stuck_title', [task]),
        body: [why, need].filter(Boolean).join(' '),
        priority: 'high',
        workspaceId: thread.workspaceId ?? null,
        agentId: thread.agentId ?? null,
        approval: { requestId: `thread:${thread.id}`, action: 'open_thread' },
      });
      // A chat he started on WhatsApp is answered there by the bridge itself when it stops: no second line
      if (cls === 'temporary' && (thread.origin !== 'whatsapp' || options.direct)) {
        this.deps.notice({ kind: 'approval', title: t('retry_stuck_line', [task, why, need]), key: id });
      }
    } catch (problem) {
      // The chat still shows the error; a report that failed must not undo the run's end
      logger.error('Could not report a stuck task', problem);
    }
  }

  /**
   * The chat waits for a step only the user can do. One Inbox item says which, per task and kind of step. An
   * agent's run asks in the Inbox itself (agents/service.ts), so it is left to it.
   */
  async asked(thread: ThreadRecord, request: ConfirmRequest): Promise<void> {
    if (request.mode !== 'needs_user' || thread.agentId || !isNeedsKind(request.kind)) return;
    const host = hostOf(request.pageUrl);
    // Asked again after the first one was answered (a second sign-in): the same item waits again
    const id = `${INBOX_SOURCE}|${needsExternalId(thread, request.kind)}`;
    if ((await this.deps.inboxItem(id).catch(() => undefined))?.status === 'done') {
      await this.deps.reopenInbox(id).catch(problem => logger.warning('Could not ask again in the Inbox', problem));
      return;
    }
    await this.deps
      .inbox({
        source: INBOX_SOURCE,
        externalId: needsExternalId(thread, request.kind),
        kind: 'approval',
        title: t(NEEDS_TITLES[request.kind], [clip(thread.title || thread.activeTask || t('retry_untitled'), 80)]),
        body: host ? t('retry_needs_body', [host]) : t('retry_needs_bodyNoHost'),
        priority: 'high',
        workspaceId: thread.workspaceId ?? null,
        agentId: null,
        approval: { requestId: `thread:${thread.id}`, action: 'open_thread' },
      })
      .catch(problem => logger.warning('Could not ask in the Inbox', problem));
  }

  /** The step was done or the run ended: its Inbox items are no longer waiting. */
  async settled(thread: Pick<ThreadRecord, 'id' | 'taskRunId'>): Promise<void> {
    for (const kind of Object.keys(NEEDS_TITLES)) {
      await this.deps.settleInbox(`${INBOX_SOURCE}|${needsExternalId(thread, kind)}`).catch(() => {});
    }
  }

  /** The task went on (it finished, or the user started it again): its "stuck" item no longer waits. */
  async resolved(thread: Pick<ThreadRecord, 'id' | 'taskRunId' | 'retryRound'>): Promise<void> {
    await this.deps.settleInbox(stuckItemId(thread)).catch(() => {});
  }

  /** Drops a queued try: the user stopped it, or started something else in the chat. */
  async cancel(threadId: string): Promise<void> {
    await this.deps
      .cancelJobs(retryJobPrefix(threadId))
      .catch(problem => logger.warning('Could not drop a try', problem));
  }

  /**
   * Puts a chat's queued try back in the job list, when the background starts: a chat that says "trying again
   * at 10:05" must have a job behind it, whatever happened to the list in between.
   */
  async requeue(thread: ThreadRecord): Promise<void> {
    const retryAt = thread.failure?.retryAt;
    if (!retryAt) return;
    const tries = thread.autoTries ?? 1;
    // Exactly one job per waiting chat: a try that was waiting for a slot or postponed to tomorrow has a job
    // under another key, and two jobs coming due together would start the chat twice
    await this.deps.cancelJobs(retryJobPrefix(thread.id));
    await this.deps.schedule({
      kind: THREAD_RETRY_JOB,
      key: retryJobKey(thread.id, tries),
      runAt: retryAt,
      payload: { threadId: thread.id, taskRunId: thread.taskRunId ?? null, tries },
    });
  }

  /**
   * The retry job: picks the task up again if it is still waiting for exactly this try, and somebody still
   * follows it. An agent that spent its day's money waits for tomorrow instead. A try that cannot start now
   * (every slot busy) looks again every half minute for half an hour, then gives up and says so. It never throws:
   * the job runner's own retries are not relied on, since they stop after five.
   */
  async runRetry(job: Pick<JobRecord, 'payload'>, threads: RetryThreads): Promise<void> {
    const payload = job.payload as RetryPayload;
    const { threadId, taskRunId } = payload;
    const thread = await threads.thread(threadId);
    // The user moved on (a new request, a manual retry, Stop), the chat is gone, or this job is a leftover of
    // an earlier try: nothing to do
    if (
      !thread ||
      thread.status !== 'error' ||
      !thread.failure?.retryAt ||
      (thread.taskRunId ?? null) !== (taskRunId ?? null) ||
      (thread.autoTries ?? 0) !== payload.tries
    ) {
      return;
    }
    // An agent's chat is only worth trying while its run still follows it: a chat nobody follows would run with
    // no step limit, no time limit and no budget check. Its run ended (the browser was closed, the user stopped
    // it) and reported for itself.
    if (thread.agentId && !(await this.deps.ownerFollows(thread).catch(() => false))) {
      await threads.drop(threadId);
      return;
    }
    const again = async (runAt: number, changes: Pick<RetryPayload, 'waits' | 'postponed'>) => {
      const next = { ...payload, ...changes };
      await this.deps.schedule({
        kind: THREAD_RETRY_JOB,
        key: retryJobKey(threadId, payload.tries, (next.waits ?? 0) + 1000 * (next.postponed ?? 0)),
        runAt,
        payload: next,
      });
    };
    try {
      if (thread.agentId) {
        const agent = await this.deps.agent(thread.agentId);
        const cap = agent?.budget.dailyUsd ?? null;
        if (agent && cap !== null && cap > 0 && (await this.deps.agentSpentUsd(agent.id)) >= cap) {
          const postponed = (payload.postponed ?? 0) + 1;
          if (postponed > MAX_POSTPONED) return void (await threads.giveUp(threadId));
          const now = this.deps.now();
          const midnight = new Date(now);
          midnight.setHours(24, 1, 0, 0);
          const runAt = now + Math.min(midnight.getTime() - now, DAY_MS);
          await again(runAt, { postponed, waits: 0 });
          await threads.postpone(threadId, runAt);
          return;
        }
      }
      try {
        await threads.resume(threadId);
      } catch (problem) {
        const waits = (payload.waits ?? 0) + 1;
        if (waits > MAX_START_WAITS) {
          logger.warning('A queued try could not start and is given up', problem);
          return void (await threads.giveUp(threadId));
        }
        await again(this.deps.now() + START_AGAIN_MS, { waits, postponed: payload.postponed });
      }
    } catch (problem) {
      // Even the fallback failed (the job list could not be written): say so rather than go quiet
      logger.error('A queued try could not be run or queued again', problem);
      await threads.giveUp(threadId).catch(() => {});
    }
  }
}
