import type { ThreadMessage } from '@extension/storage';

export type StepKind =
  'plan' | 'click' | 'navigate' | 'type' | 'search' | 'read' | 'scroll' | 'wait' | 'tab' | 'note' | 'error' | 'step';

export interface TurnStep {
  id: string;
  kind: StepKind;
  text: string;
  ts: number;
  // A planner message's vouched tasks (ThreadMessage.taskIds)
  taskIds?: string[];
  // The message's workspace lines are buttons (ThreadMessage.workspaceLines)
  workspaceLines?: boolean;
}

export interface Turn {
  id: string;
  // What the user asked; null for a thread that starts without one, such as meeting notes
  request: ThreadMessage | null;
  steps: TurnStep[];
  // The copilot's final words for this turn, once it has them
  answer: ThreadMessage | null;
  // The run of this turn is still going
  active: boolean;
  startedAt: number;
  endedAt: number;
}

const ERROR = /\b(fail|failed|error|cancel+ed|stopped|blocked|refused|interrupted)\b/i;

/** What a step was, from its text, for its icon on the run trail. */
export function stepKind(message: Pick<ThreadMessage, 'actor' | 'content'>): StepKind {
  const text = message.content.toLowerCase();
  if (message.actor === 'planner') return 'plan';
  if (message.actor === 'system') return ERROR.test(text) ? 'error' : 'note';
  if (ERROR.test(text)) return 'error';
  if (/\bclick/.test(text)) return 'click';
  if (/\b(typ|input|fill|enter|writ)/.test(text)) return 'type';
  if (/\b(search|look(ing)? (up|for)|find)/.test(text)) return 'search';
  if (/\b(read|extract|cache)/.test(text)) return 'read';
  if (/\bscroll/.test(text)) return 'scroll';
  if (/\bwait/.test(text)) return 'wait';
  if (/\b(tab)\b/.test(text)) return 'tab';
  if (/\b(navigat|open|go(ing)? to|visit|load)/.test(text)) return 'navigate';
  return 'step';
}

/**
 * A thread's messages as turns: each request, the steps taken for it, and the answer. While a run is
 * going, everything after the request is a step; once it ends, the last thing the planner said is the
 * answer, unless the run ended in a failure note after it.
 */
export function toTurns(messages: ThreadMessage[], running: boolean): Turn[] {
  const sorted = [...messages].sort((a, b) => a.seq - b.seq);
  const groups: { request: ThreadMessage | null; rest: ThreadMessage[] }[] = [];
  for (const message of sorted) {
    if (message.actor === 'user') groups.push({ request: message, rest: [] });
    else if (groups.length === 0) groups.push({ request: null, rest: [message] });
    else groups[groups.length - 1].rest.push(message);
  }

  return groups.map((group, index) => {
    const active = running && index === groups.length - 1;
    let answer: ThreadMessage | null = null;
    let stepsSource = group.rest;
    if (!active) {
      const lastPlanner = group.rest.map(message => message.actor).lastIndexOf('planner');
      // A turn with only the planner's words, like meeting notes or a voice reply, is all answer
      if (lastPlanner !== -1 && !group.rest.slice(lastPlanner + 1).some(message => message.actor !== 'planner')) {
        answer = group.rest[lastPlanner];
        stepsSource = group.rest.slice(0, lastPlanner);
      }
    }
    // The navigator's own "done" action says nothing the answer does not
    const steps = stepsSource
      .filter(message => !(message.actor === 'navigator' && message.content.trim() === 'done'))
      .map(message => ({
        id: message.id,
        kind: stepKind(message),
        text: message.content,
        ts: message.ts,
        ...(message.taskIds?.length ? { taskIds: message.taskIds } : {}),
        ...(message.workspaceLines ? { workspaceLines: true } : {}),
      }));
    const all = [group.request, ...group.rest].filter((message): message is ThreadMessage => message !== null);
    return {
      id: group.request?.id ?? group.rest[0]?.id ?? String(index),
      request: group.request,
      steps,
      answer,
      active,
      startedAt: all[0]?.ts ?? 0,
      endedAt: all[all.length - 1]?.ts ?? 0,
    };
  });
}

/** A duration as m:ss. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
