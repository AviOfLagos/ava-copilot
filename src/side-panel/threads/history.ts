import type { ThreadRecord } from '@extension/storage';

export type HistoryGroupKey = 'pinned' | 'today' | 'yesterday' | 'week' | 'month' | 'older';

export interface HistoryGroup {
  key: HistoryGroupKey | `month:${string}`;
  // A month's name for months before the last 30 days, e.g. "August 2026"
  label?: string;
  threads: ThreadRecord[];
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Chats grouped the way chat apps show them: pinned first, then Today, Yesterday, Previous 7 days,
 * Previous 30 days, then one group per month. Newest first inside each group.
 */
export function groupByDate(threads: ThreadRecord[], now = Date.now()): HistoryGroup[] {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  const groups = new Map<string, HistoryGroup>();
  const add = (key: HistoryGroup['key'], thread: ThreadRecord, label?: string) => {
    if (!groups.has(key)) groups.set(key, { key, label, threads: [] });
    groups.get(key)!.threads.push(thread);
  };

  for (const thread of [...threads].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const at = thread.updatedAt;
    if (thread.pinned) add('pinned', thread);
    else if (at >= today) add('today', thread);
    else if (at >= today - DAY) add('yesterday', thread);
    else if (at >= today - 7 * DAY) add('week', thread);
    else if (at >= today - 30 * DAY) add('month', thread);
    else {
      const date = new Date(at);
      const key = `month:${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` as const;
      add(key, thread, date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
    }
  }
  const order = ['pinned', 'today', 'yesterday', 'week', 'month'];
  return [...groups.values()].sort((a, b) => {
    const ai = order.indexOf(a.key);
    const bi = order.indexOf(b.key);
    if (ai >= 0 || bi >= 0) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return b.key.localeCompare(a.key);
  });
}
