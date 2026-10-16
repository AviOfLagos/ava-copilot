import type { UsageEvent } from '../models/types';

/**
 * Usage per model, agent, routine, workspace or day, added up from the `usageEvents` table (one row per
 * model call). Pure, so the Models page and the tests share it.
 */

// Usage events older than this are deleted by the retention job
export const USAGE_RETENTION_DAYS = 90;

export type UsageDimension = 'day' | 'model' | 'provider' | 'agent' | 'workflow' | 'workspace';

export interface UsageRow {
  // The day (YYYY-MM-DD), "<providerId>:<model>", the provider, agent, routine or workspace id; '' for none
  key: string;
  // What calls with a known price cost; calls with none are counted in unpricedCalls and unpricedTokens
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  unpricedCalls: number;
  unpricedTokens: number;
}

const emptyRow = (key: string): UsageRow => ({
  key,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  calls: 0,
  unpricedCalls: 0,
  unpricedTokens: 0,
});

function keyOf(event: UsageEvent, by: UsageDimension): string {
  switch (by) {
    case 'day':
      return event.day;
    case 'model':
      return `${event.providerId}:${event.model}`;
    case 'provider':
      return event.providerId;
    case 'agent':
      return event.agentId ?? '';
    case 'workflow':
      return event.workflowId ?? '';
    case 'workspace':
      return event.workspaceId ?? '';
  }
}

function add(row: UsageRow, event: UsageEvent): void {
  row.inputTokens += event.inputTokens;
  row.outputTokens += event.outputTokens;
  row.calls += 1;
  if (event.costUsd === null) {
    row.unpricedCalls += 1;
    row.unpricedTokens += event.inputTokens + event.outputTokens;
  } else {
    row.costUsd += event.costUsd;
  }
}

/** The local calendar day as YYYY-MM-DD (as `localDay` in ./index). */
function dayOf(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The last `count` local days, oldest first, ending with the day of `now`. */
export function lastDays(count: number, now = new Date()): string[] {
  const days: string[] = [];
  for (let back = count - 1; back >= 0; back--) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 12);
    days.push(dayOf(date));
  }
  return days;
}

/** The first day kept by the retention job: older events go. */
export function retentionCutoffDay(now = new Date(), days = USAGE_RETENTION_DAYS): string {
  return dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 12));
}

/**
 * Adds events up by one dimension. By day, every day in `days` gets a row (oldest first), with zeros for
 * quiet days; otherwise rows go from the most expensive down, then by tokens.
 */
export function summarizeUsage(events: UsageEvent[], by: UsageDimension, days?: string[]): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  if (by === 'day' && days) {
    for (const day of days) rows.set(day, emptyRow(day));
  }
  for (const event of events) {
    const key = keyOf(event, by);
    if (by === 'day' && days && !rows.has(key)) continue;
    const row = rows.get(key) ?? emptyRow(key);
    add(row, event);
    rows.set(key, row);
  }
  const list = [...rows.values()];
  if (by === 'day') return list.sort((a, b) => a.key.localeCompare(b.key));
  return list.sort(
    (a, b) =>
      b.costUsd - a.costUsd ||
      b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) ||
      a.key.localeCompare(b.key),
  );
}

/** Everything in the events, as one row. */
export function totalUsage(events: UsageEvent[]): UsageRow {
  const row = emptyRow('');
  for (const event of events) add(row, event);
  return row;
}

/** Light work that ran on a local model: how many calls, and what the cloud model it replaced would have cost. */
export function lightSavings(events: UsageEvent[]): { calls: number; savedUsd: number } {
  let calls = 0;
  let savedUsd = 0;
  for (const event of events) {
    if (!event.light) continue;
    calls += 1;
    savedUsd += event.savedUsd ?? 0;
  }
  return { calls, savedUsd };
}
