import { t } from '@extension/i18n';
import { AppError } from '@extension/shared';
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
// One job per try, not one per chat: the job runner writes "done" on a job after its handler returns, and a
// try that fails at once must not have its successor (queued by then) overwritten by that write
export const retryJobKey = (threadId: string, triesSoFar: number): string => `thread-retry:${threadId}:${triesSoFar}`;
// The job runner gives up on a job after this many attempts (see ../jobs/runner.ts)
const JOB_LAST_ATTEMPT = 5;
// A try that could not start (every slot busy, its tab in use) is tried again this soon
const START_AGAIN_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const INBOX_SOURCE = 'system';
export const stuckItemId = (thread: Pick<ThreadRecord, 'id' | 'taskRunId'>): string =>
  `${INBOX_SOURCE}|stuck:${thread.taskRunId ?? thread.id}`;
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
}

export interface RunEndingDeps {
  schedule(request: { kind: string; key: string; runAt: number; payload: RetryPayload }): Promise<unknown>;
  cancelJob(key: string): Promise<void>;
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
  ): Promise<Ending> {
    const cls = classify(error.kind, code);
    const tries = thread.autoTries ?? 0;
    const now = this.deps.now();
    const retryAt = cls === 'temporary' ? nextRetryAt(tries, now) : null;
    if (retryAt !== null) {
      await this.deps.schedule({
        kind: THREAD_RETRY_JOB,
        key: retryJobKey(thread.id, tries),
        runAt: retryAt,
        payload: { threadId: thread.id, taskRunId: thread.taskRunId ?? null },
      });
      const minutes = Math.round((retryAt - now) / 60_000);
      await this.deps
        .note(thread.id, t('retry_queued', [String(minutes), String(tries + 1), String(MAX_AUTO_TRIES)]))
        .catch(problem => logger.warning('Could not note the queued try', problem));
      return { failure: { cls, retryAt, reported: false }, autoTries: tries + 1 };
    }
    await this.report(thread, cls, error.message, code);
    return { failure: { cls, retryAt: null, reported: true }, autoTries: tries };
  }

  /**
   * Tells the user a task is stuck: one Inbox item, and one WhatsApp line when it gave up after its tries.
   * Called again for the same task, it does nothing: there is never a second one.
   */
  async report(thread: ThreadRecord, cls: FailureClass, reason: string, code?: FailureCode | null): Promise<void> {
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
      // A chat he started on WhatsApp is answered there by the bridge itself: no second line
      if (cls === 'temporary' && thread.origin !== 'whatsapp') {
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

  /** Drops a queued try: the user stopped it, or started something else in the chat. */
  async cancel(threadId: string): Promise<void> {
    for (let tries = 0; tries < MAX_AUTO_TRIES; tries++) {
      await this.deps
        .cancelJob(retryJobKey(threadId, tries))
        .catch(problem => logger.warning('Could not drop a try', problem));
    }
  }

  /**
   * Puts a chat's queued try back in the job list, when the background starts: a chat that says "trying again
   * at 10:05" must have a job behind it, whatever happened to the list in between.
   */
  async requeue(thread: ThreadRecord): Promise<void> {
    const retryAt = thread.failure?.retryAt;
    if (!retryAt) return;
    await this.deps.schedule({
      kind: THREAD_RETRY_JOB,
      key: retryJobKey(thread.id, Math.max(0, (thread.autoTries ?? 1) - 1)),
      runAt: retryAt,
      payload: { threadId: thread.id, taskRunId: thread.taskRunId ?? null },
    });
  }

  /**
   * The retry job: picks the task up again if it is still waiting for exactly this try. An agent that spent its
   * day's money waits for tomorrow instead. A try that cannot start now is tried again shortly, and given up
   * (and reported) rather than left queued for ever.
   */
  async runRetry(job: Pick<JobRecord, 'payload' | 'attempts'>, threads: RetryThreads): Promise<void> {
    const { threadId, taskRunId } = job.payload as RetryPayload;
    const thread = await threads.thread(threadId);
    // The user moved on (a new request, a manual retry, Stop) or the chat is gone: nothing to do
    if (
      !thread ||
      thread.status !== 'error' ||
      !thread.failure?.retryAt ||
      (thread.taskRunId ?? null) !== (taskRunId ?? null)
    ) {
      return;
    }
    const last = job.attempts >= JOB_LAST_ATTEMPT;
    if (thread.agentId && !last) {
      const agent = await this.deps.agent(thread.agentId);
      const cap = agent?.budget.dailyUsd ?? null;
      if (agent && cap !== null && cap > 0 && (await this.deps.agentSpentUsd(agent.id)) >= cap) {
        const now = this.deps.now();
        const midnight = new Date(now);
        midnight.setHours(24, 1, 0, 0);
        const wait = Math.min(midnight.getTime() - now, DAY_MS);
        await threads.postpone(threadId, now + wait);
        throw new AppError('budget', `"${agent.name}" spent its money for today; its task is tried again tomorrow.`, {
          retryable: true,
          retryAfterMs: wait,
        });
      }
    }
    try {
      await threads.resume(threadId);
    } catch (problem) {
      if (last) {
        await threads.giveUp(threadId);
        return;
      }
      throw new AppError('unavailable', problem instanceof Error ? problem.message : String(problem), {
        cause: problem,
        retryable: true,
        retryAfterMs: START_AGAIN_MS,
      });
    }
  }
}
