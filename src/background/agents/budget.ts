import { localDay } from '@extension/storage';
import type { AgentProfile, AviCopilotDb, UsageEvent } from '@extension/storage';

/**
 * What an agent may still spend: runs a day, US dollars a day (from usage events carrying its id), and model
 * calls in one run. The checks are pure; the sums read the database.
 */

export function startOfLocalDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export interface UsageSum {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  calls: number;
  // Calls to models with no known price; their cost is not in costUsd
  unpriced: number;
}

export const EMPTY_SUM: UsageSum = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0, unpriced: 0 };

export function sumUsage(events: readonly UsageEvent[]): UsageSum {
  return events.reduce(
    (sum, event) => ({
      inputTokens: sum.inputTokens + event.inputTokens,
      outputTokens: sum.outputTokens + event.outputTokens,
      costUsd: sum.costUsd + (event.costUsd ?? 0),
      calls: sum.calls + 1,
      unpriced: sum.unpriced + (event.costUsd === null ? 1 : 0),
    }),
    { ...EMPTY_SUM },
  );
}

/** An agent's usage on one day (today by default). */
export async function agentSpend(db: AviCopilotDb, agentId: string, day = localDay()): Promise<UsageSum> {
  return sumUsage(
    await db.usageEvents
      .where('agentId')
      .equals(agentId)
      .filter(event => event.day === day)
      .toArray(),
  );
}

/** What one run's chat spent since the run started. */
export async function runUsage(db: AviCopilotDb, agentId: string, threadId: string, since: number): Promise<UsageSum> {
  return sumUsage(
    await db.usageEvents
      .where('agentId')
      .equals(agentId)
      .filter(event => event.sessionId === threadId && event.at >= since)
      .toArray(),
  );
}

/** How many runs an agent made today, whatever started them. */
export async function runsToday(db: AviCopilotDb, agentId: string, now = Date.now()): Promise<number> {
  const since = startOfLocalDay(now);
  return db.runs
    .where('agentId')
    .equals(agentId)
    .filter(run => run.kind === 'agent' && run.startedAt >= since)
    .count();
}

/** Why a new run may not start (a limit reached), or null. */
export function budgetBlock(
  agent: Pick<AgentProfile, 'name' | 'budget'>,
  today: { runs: number; spentUsd: number },
): string | null {
  if (today.runs >= agent.budget.runsPerDay) {
    return `"${agent.name}" reached its limit of ${agent.budget.runsPerDay} runs today.`;
  }
  return spendBlock(agent, today.spentUsd);
}

/** Why the agent must stop spending today, or null. */
export function spendBlock(agent: Pick<AgentProfile, 'name' | 'budget'>, spentUsd: number): string | null {
  const cap = agent.budget.dailyUsd;
  if (cap !== null && cap > 0 && spentUsd >= cap) {
    return `"${agent.name}" spent its $${cap.toFixed(2)} for today.`;
  }
  return null;
}

/** Why a run must stop now (too many model calls), or null. */
export function stepBlock(agent: Pick<AgentProfile, 'name' | 'budget'>, calls: number): string | null {
  return calls > agent.budget.maxStepsPerRun
    ? `"${agent.name}" reached its limit of ${agent.budget.maxStepsPerRun} steps in one run.`
    : null;
}
