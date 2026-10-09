import type { MeetingRecord, ThreadMessage, ThreadRecord, TranscriptSegment } from '@extension/storage';

export type HourMark = 'task' | 'held' | 'call';

export interface Today {
  // 24 hours, each with how many tasks started, how many waited for a click, and whether a call ran
  hours: { tasks: number; held: number; call: boolean }[];
  stepsTaken: number;
  heldSent: number;
  heldStopped: number;
  wordsCaught: number;
  callMinutes: number;
  calls: number;
  finishedTasks: number;
  costUsd: number;
  // Where the agent worked, by site, largest first
  sites: { host: string; share: number }[];
}

export interface TodayInput {
  messages: Pick<ThreadMessage, 'threadId' | 'actor' | 'content' | 'ts'>[];
  threads: Pick<ThreadRecord, 'id' | 'boundUrl'>[];
  meetings: Pick<MeetingRecord, 'id' | 'startedAt' | 'endedAt'>[];
  segments: Pick<TranscriptSegment, 'meetingId' | 'text'>[];
  costUsd: number;
  // The start of the gate's notes, e.g. "Confirmed:" and "Cancelled:", in the panel's language
  approvedPrefix: string;
  declinedPrefix: string;
  dayStart: number;
  now: number;
}

const HOUR = 60 * 60 * 1000;

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/**
 * The day in numbers the extension really has: tasks started, steps it took, what waited for the
 * user's click, calls and their words, and what it all cost.
 */
export function summarizeToday(input: TodayInput): Today {
  const { dayStart, now } = input;
  const hours = Array.from({ length: 24 }, () => ({ tasks: 0, held: 0, call: false }));
  const hourOf = (ts: number) => Math.min(23, Math.max(0, Math.floor((ts - dayStart) / HOUR)));
  const today = input.messages.filter(message => message.ts >= dayStart && message.ts <= now);

  let stepsTaken = 0,
    heldSent = 0,
    heldStopped = 0,
    finishedTasks = 0;
  const siteCounts = new Map<string, number>();
  const boundUrl = new Map(input.threads.map(thread => [thread.id, thread.boundUrl]));

  for (const message of today) {
    if (message.actor === 'user') hours[hourOf(message.ts)].tasks += 1;
    if (message.actor === 'navigator' && message.content.trim() !== 'done') {
      stepsTaken += 1;
      const host = hostOf(boundUrl.get(message.threadId) ?? null);
      if (host) siteCounts.set(host, (siteCounts.get(host) ?? 0) + 1);
    }
    if (message.actor === 'system' && message.content.startsWith(input.approvedPrefix)) {
      heldSent += 1;
      hours[hourOf(message.ts)].held += 1;
    }
    if (message.actor === 'system' && message.content.startsWith(input.declinedPrefix)) {
      heldStopped += 1;
      hours[hourOf(message.ts)].held += 1;
    }
  }

  // A task finished when the planner had the last word of its turn
  const byThread = new Map<string, typeof today>();
  for (const message of today) byThread.set(message.threadId, [...(byThread.get(message.threadId) ?? []), message]);
  for (const messages of byThread.values()) {
    messages.sort((a, b) => a.ts - b.ts);
    messages.forEach((message, index) => {
      const next = messages[index + 1];
      if (message.actor === 'planner' && (!next || next.actor === 'user')) finishedTasks += 1;
    });
  }

  let callMs = 0,
    calls = 0;
  const callIds = new Set<string>();
  for (const meeting of input.meetings) {
    const end = meeting.endedAt ?? now;
    if (end < dayStart || meeting.startedAt > now) continue;
    calls += 1;
    callIds.add(meeting.id);
    const from = Math.max(meeting.startedAt, dayStart);
    callMs += end - from;
    for (let h = hourOf(from); h <= hourOf(end); h++) hours[h].call = true;
  }
  const wordsCaught = input.segments
    .filter(segment => callIds.has(segment.meetingId))
    .reduce((sum, segment) => sum + segment.text.split(/\s+/).filter(Boolean).length, 0);

  const total = [...siteCounts.values()].reduce((a, b) => a + b, 0);
  const sites = [...siteCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([host, count]) => ({ host, share: count / total }));

  return {
    hours,
    stepsTaken,
    heldSent,
    heldStopped,
    wordsCaught,
    callMinutes: Math.round(callMs / 60000),
    calls,
    finishedTasks,
    costUsd: input.costUsd,
    sites,
  };
}

/** Sites past the first three, as one "other" share. */
export function topSites(sites: Today['sites'], keep = 3): Today['sites'] {
  if (sites.length <= keep + 1) return sites;
  const rest = sites.slice(keep).reduce((sum, site) => sum + site.share, 0);
  return [...sites.slice(0, keep), { host: 'other', share: rest }];
}
