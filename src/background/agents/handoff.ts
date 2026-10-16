import { AppError } from '@extension/shared';
import { createThreadStore } from '@extension/storage';
import type {
  AgentHandoff,
  AgentProfile,
  AgentRunSpec,
  AviCopilotDb,
  RunRecord,
  ThreadRecord,
} from '@extension/storage';
import type { JobRunner } from '../jobs/runner';
import { createLogger } from '../log';
import { handoffState } from './handoff-state';
import { areaKey, normalArea, ownsWork } from './profile';
import { teamLines, teamOf } from './team-section';
import type { RunRequest } from './service';
import { findAgent, isTerminalRun } from './service';

/**
 * Ava hands work to the agent that owns its area: "have the research agent look into X" from a chat or a voice
 * conversation starts a run of that agent with the task, and the run's answer is posted back in the chat that
 * handed it over. The chat shows a card that follows the run record (see side-panel/agents/HandoffCard.tsx).
 *
 * Only a chat the user is in can hand work over (never an agent's or a routine's own chat, so an agent run can
 * never chain one; the bus keeps its own hop limit). The task is trusted only when it is the user's own words;
 * anything else Ava added goes to the agent as data. Workspaces never mix: a chat sees only its workspace's agents
 * and the agents in none.
 */

const logger = createLogger('Agents');

export { handoffState } from './handoff-state';
export { teamLines, teamOf, teamSection } from './team-section';
export type { HandoffState } from './handoff-state';

export const HANDOFF_POST_JOB = 'agent-handoff-post';
export const handoffPostKey = (runId: string) => `agent-handoff:${runId}`;
// A chat busy with another task gets the answer once it is free, checked this often, for at most POST_WAIT_MS
export const POST_RETRY_MS = 5000;
export const POST_WAIT_MS = 10 * 60_000;
// Meanwhile the background itself looks every second, for at most 20 s (longer waits are the job's)
const WATCH_MS = 20_000;
const WATCH_POLL_MS = 1000;
// Answers of runs that ended this long ago are not posted after a restart
export const RECOVER_WITHIN_MS = 24 * 60 * 60_000;
const MAX_TASK = 2000;

// Chats nobody is watching: they never hand work over
const UNATTENDED: ReadonlySet<string> = new Set(['agent', 'workflow', 'brief']);

/** Whether the user is in this chat (typed or spoken), so it may hand work to an agent. */
export const isAttendedThread = (thread: Pick<ThreadRecord, 'origin'> | undefined): boolean =>
  Boolean(thread) && !(thread!.origin && UNATTENDED.has(thread!.origin));

// ── Pure parts ────────────────────────────────────────────────────────────────────────────────────

const words = (key: string) => key.split(' ').filter(Boolean);

/** Whether an area the user named falls in an area an agent owns: the same, or one's words all in the other. */
function areaMatches(asked: string, owned: string): boolean {
  if (asked === owned) return true;
  const a = words(asked);
  const b = words(owned);
  return (b.length > 0 && b.every(word => a.includes(word))) || (a.length > 0 && a.every(word => b.includes(word)));
}

export type HandoffTarget = { agent: AgentProfile; area: string | null } | { error: string };

/** Which agent of the team takes the work: the one named, else the switched-on owner of the area. */
export function resolveHandoff(
  team: readonly AgentProfile[],
  wanted: { area?: string; agent?: string },
): HandoffTarget {
  const named = wanted.agent?.trim();
  if (named) {
    const agent = findAgent(team, named);
    if (agent) return { agent, area: wanted.area?.trim() ? normalArea(wanted.area) : null };
  }
  const area = wanted.area?.trim() ?? '';
  const key = areaKey(area);
  if (key) {
    const owning = (agent: AgentProfile, match: (asked: string, owned: string) => boolean) =>
      (agent.owns ?? []).some(owned => match(key, areaKey(owned)));
    const exact = (asked: string, owned: string) => asked === owned;
    for (const match of [exact, areaMatches]) {
      const on = team.find(agent => ownsWork(agent) && owning(agent, match));
      if (on) return { agent: on, area: normalArea(area) };
      const paused = team.find(agent => owning(agent, match));
      if (paused)
        return { error: `"${paused.name}" owns ${normalArea(area)} but is paused: resume it in Agents first.` };
    }
  }
  const lines = teamLines(team);
  const what = named ? `There is no agent "${named}" here` : `No agent owns "${area || 'that'}" here`;
  return {
    error: lines.length
      ? `${what}. The agents and what they own:\n${lines.join('\n')}`
      : `${what}: no agent of this workspace owns an area yet. The user can set up a team in Agents.`,
  };
}

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;
const tokens = (text: string) => (text.toLowerCase().match(TOKEN) ?? []).filter(word => word.length >= 3);

/**
 * The task an agent may trust: Ava's wording when the user's own words cover it (nearly every word of it was
 * said), else the user's words themselves, with Ava's wording passed on as data (it may carry what a page said).
 */
export function trustedTask(task: string, userWords: string): { task: string; note: string | null } {
  const asked = task.trim().slice(0, MAX_TASK);
  const said = userWords.trim().slice(-MAX_TASK);
  if (!asked) return { task: said, note: null };
  const heard = new Set(tokens(said));
  const mine = tokens(asked);
  const covered = mine.filter(word => heard.has(word)).length;
  if (mine.length === 0 || covered / mine.length >= 0.8) return { task: asked, note: null };
  return { task: said, note: asked };
}

/** What the chat is told when a handed-over run ends. */
export function handoffMessage(agentName: string, run: Pick<RunRecord, 'status' | 'error'>, answer: string): string {
  switch (handoffState(run)) {
    case 'done':
      return `**${agentName}** is done:\n\n${answer.trim() || 'It finished and said nothing back.'}`;
    case 'stopped':
      return `**${agentName}** was stopped before it finished.`;
    default:
      return `**${agentName}** could not finish: ${run.error?.message || 'something went wrong'}.`;
  }
}

// ── The service ───────────────────────────────────────────────────────────────────────────────────

export interface HandoffDeps {
  db: AviCopilotDb;
  requestRun: (agentId: string, request: RunRequest) => Promise<RunRecord>;
  jobs: Pick<JobRunner, 'schedule'>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface HandoffRequest {
  // The chat handing it over: a chat the user typed in, or the voice conversation's chat
  threadId: string;
  from: AgentHandoff['from'];
  area?: string;
  agent?: string;
  task: string;
  // What the user said or typed: the only words the task may be trusted from
  userWords: string;
}

export class HandoffService {
  private readonly threads: ReturnType<typeof createThreadStore>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly watching = new Set<string>();

  constructor(private readonly deps: HandoffDeps) {
    this.threads = createThreadStore(deps.db);
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  /** The chat's team: the created agents of its workspace and of none. */
  async teamFor(threadId: string): Promise<AgentProfile[]> {
    const thread = await this.deps.db.threads.get(threadId);
    return teamOf(await this.deps.db.agents.toArray(), thread?.workspaceId ?? null);
  }

  /**
   * Starts a run of the agent that owns the work, with the task, from a chat the user is in. Throws an AppError with
   * a plain sentence when it cannot: not a chat with the user, no such agent or owner, a draft, a budget reached.
   */
  async handOff(request: HandoffRequest): Promise<{ agent: AgentProfile; run: RunRecord; area: string | null }> {
    const thread = await this.deps.db.threads.get(request.threadId);
    if (!thread) throw new AppError('not_found', 'The chat is gone.');
    if (!isAttendedThread(thread)) {
      throw new AppError(
        'forbidden',
        'Only a chat with the user can hand work to an agent, never an agent or a routine.',
      );
    }
    const team = teamOf(await this.deps.db.agents.toArray(), thread.workspaceId ?? null);
    const target = resolveHandoff(team, { area: request.area, agent: request.agent });
    if ('error' in target) throw new AppError('not_found', target.error);
    const { agent, area } = target;

    const messages = await this.threads.messages(thread.id);
    const requestSeq = messages.filter(message => message.actor === 'user').at(-1)?.seq ?? null;
    const trusted = trustedTask(request.task, request.userWords);
    if (!trusted.task) throw new AppError('invalid', 'There is no task to hand over.');
    const run = await this.deps.requestRun(agent.id, {
      trigger: { type: 'handoff', detail: thread.id },
      // The user asked for it and sees its card
      attended: true,
      // Ava's own wording, when the user's words do not cover it, may carry page content: data, and the run tainted
      tainted: trusted.note !== null,
      task: trusted.task,
      data: trusted.note
        ? `How the assistant put the task (its words may carry what a page said):\n${trusted.note}`
        : null,
      // Behind its open run rather than refused: the user asked for it
      queueIfBusy: true,
      handoff: { threadId: thread.id, requestSeq, area, from: request.from },
    });
    return { agent, run, area };
  }

  /**
   * Posts a handed-over run's answer in its chat, once, after the run ended. A chat busy with another task gets it
   * when it is free (a job checks again), so it is not lost in that task's steps.
   */
  async deliver(runId: string): Promise<void> {
    const { db } = this.deps;
    const run = await db.runs.get(runId);
    const handoff = (run?.spec as AgentRunSpec | undefined)?.handoff;
    if (!run || !handoff || handoff.postedAt || !isTerminalRun(run.status)) return;
    const thread = await db.threads.get(handoff.threadId);
    if (!thread) return void (await this.markPosted(run, handoff));
    const busy = thread.status === 'running' || thread.status === 'waiting_confirm';
    if (busy && this.now() - (run.endedAt ?? this.now()) < POST_WAIT_MS) {
      await this.deps.jobs.schedule({
        kind: HANDOFF_POST_JOB,
        key: handoffPostKey(run.id),
        runAt: this.now() + POST_RETRY_MS,
        payload: { runId: run.id },
      });
      // The job keeps it across a restart; while this background lives, the chat is watched closely too
      void this.watchChat(run.id, handoff.threadId);
      return;
    }
    const task = await db.runSteps
      .where('runId')
      .equals(run.id)
      .filter(step => step.nodeId === 'task')
      .first();
    const agentName = (run.spec as AgentRunSpec).agentName;
    const text = handoffMessage(agentName, run, String(task?.output ?? ''));
    const posted = await db.transaction('rw', db.runs, db.threads, db.messages, async () => {
      const current = await db.runs.get(run.id);
      const spec = current?.spec as AgentRunSpec | undefined;
      if (!current || !spec?.handoff || spec.handoff.postedAt) return false;
      await db.runs.update(run.id, { spec: { ...spec, handoff: { ...spec.handoff, postedAt: this.now() } } });
      await this.threads.addMessage(handoff.threadId, 'planner', text);
      return true;
    });
    if (posted) logger.info(`Posted the answer of "${agentName}" in its chat`);
  }

  /** After a restart: answers of hand-offs that ended without being posted are posted now. */
  async recover(): Promise<void> {
    const since = this.now() - RECOVER_WITHIN_MS;
    const ended = await this.deps.db.runs
      .where('kind')
      .equals('agent')
      .filter(run => {
        const handoff = (run.spec as AgentRunSpec | undefined)?.handoff;
        return Boolean(handoff && !handoff.postedAt && isTerminalRun(run.status) && (run.endedAt ?? 0) > since);
      })
      .toArray();
    for (const run of ended) {
      await this.deliver(run.id).catch(error => logger.warning('Could not post a hand-off answer', error));
    }
  }

  /** Checks a busy chat every second for a short while, and posts the answer as soon as it is free. */
  private async watchChat(runId: string, threadId: string): Promise<void> {
    if (this.watching.has(runId)) return;
    this.watching.add(runId);
    try {
      for (let waited = 0; waited < WATCH_MS; waited += WATCH_POLL_MS) {
        await this.sleep(WATCH_POLL_MS);
        const thread = await this.deps.db.threads.get(threadId);
        if (!thread || (thread.status !== 'running' && thread.status !== 'waiting_confirm')) {
          await this.deliver(runId);
          return;
        }
      }
    } catch (error) {
      logger.warning('Could not watch the chat of a hand-off', error);
    } finally {
      this.watching.delete(runId);
    }
  }

  private async markPosted(run: RunRecord, handoff: AgentHandoff): Promise<void> {
    const spec = run.spec as AgentRunSpec;
    await this.deps.db.runs.update(run.id, { spec: { ...spec, handoff: { ...handoff, postedAt: this.now() } } });
  }
}
