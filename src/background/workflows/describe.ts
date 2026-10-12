import type { WorkflowNode, WorkflowSpec } from './spec';

/**
 * Workflows in words: the shape of a schedule (for the panel to say in the user's language) and short
 * English lines for the agent and voice, which answer in the user's language themselves.
 */

export type CronShape =
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'hourly'; minute: number }
  | { kind: 'every'; minutes: number }
  | { kind: 'custom' };

const pad = (value: number) => String(value).padStart(2, '0');
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function number(text: string, max: number): number | null {
  if (!/^\d{1,2}$/.test(text)) return null;
  const value = Number(text);
  return value <= max ? value : null;
}

function dayNumber(text: string): number | null {
  const lower = text.toLowerCase();
  if (lower in DAY_NAMES) return DAY_NAMES[lower];
  const value = number(text, 7);
  return value === null ? null : value % 7;
}

/** The common shapes of a five-field cron expression; anything else is 'custom'. */
export function cronShape(cron: string): CronShape {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { kind: 'custom' };
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (dayOfMonth !== '*' || month !== '*') return { kind: 'custom' };
  const m = number(minute, 59);
  const h = number(hour, 23);
  if (m !== null && h !== null) {
    const time = `${pad(h)}:${pad(m)}`;
    if (dayOfWeek === '*') return { kind: 'daily', time };
    if (/^(1-5|mon-fri)$/i.test(dayOfWeek)) return { kind: 'weekdays', time };
    const days = dayOfWeek.split(',').map(dayNumber);
    if (days.every(day => day !== null)) return { kind: 'weekly', days: [...new Set(days as number[])].sort(), time };
    return { kind: 'custom' };
  }
  if (m !== null && hour === '*' && dayOfWeek === '*') return { kind: 'hourly', minute: m };
  const every = /^\*\/(\d{1,2})$/.exec(minute);
  if (every && hour === '*' && dayOfWeek === '*') return { kind: 'every', minutes: Number(every[1]) };
  return { kind: 'custom' };
}

/** A schedule in English, e.g. "every day at 07:30". */
export function cronText(cron: string): string {
  const shape = cronShape(cron);
  switch (shape.kind) {
    case 'daily':
      return `every day at ${shape.time}`;
    case 'weekdays':
      return `on weekdays at ${shape.time}`;
    case 'weekly':
      return `every ${shape.days.map(day => WEEKDAYS[day]).join(', ')} at ${shape.time}`;
    case 'hourly':
      return `every hour at minute ${shape.minute}`;
    case 'every':
      return `every ${shape.minutes} minutes`;
    default:
      return `on the schedule "${cron}"`;
  }
}

/** How a workflow starts, in English. */
export function triggerText(spec: Pick<WorkflowSpec, 'nodes'>): string {
  const parts = spec.nodes.flatMap(node => {
    switch (node.type) {
      case 'trigger.schedule':
        return [`${cronText(node.cron)} (${node.timezone})`];
      case 'trigger.event':
        return [node.event === 'meeting_ended' ? 'when a meeting ends' : 'when something lands in the inbox'];
      case 'trigger.tab':
        return [`when a tab opens ${node.urlPattern}`];
      case 'trigger.manual':
        return ['by hand'];
      default:
        return [];
    }
  });
  return parts.length ? parts.join(' or ') : 'by hand';
}

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function cut(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One short line about what a node does, e.g. "GET hn.algolia.com" or "daily 07:30". */
export function nodeDetail(node: WorkflowNode): string {
  switch (node.type) {
    case 'trigger.schedule':
      return cronText(node.cron);
    case 'trigger.manual':
      return 'by hand';
    case 'trigger.event':
      return node.event === 'meeting_ended' ? 'meeting ended' : 'inbox item';
    case 'trigger.tab':
      return node.urlPattern;
    case 'step.http_get':
    case 'step.read_page':
      return host(node.url);
    case 'step.web_search':
      return cut(node.query);
    case 'step.browse':
      return cut(node.task);
    case 'step.memory_search':
      return cut(node.query);
    case 'step.memory_save':
      return cut(node.title);
    case 'step.llm':
      return cut(node.instructions);
    case 'step.condition':
      return `${cut(node.left, 20)} ${node.op.replace(/_/g, ' ')} ${cut(node.right, 20)}`.trim();
    case 'step.agent':
      return cut(node.task);
    case 'step.tool':
      return `${node.connector} · ${node.tool}`;
    case 'step.sandbox':
      return cut(node.command);
    case 'out.inbox':
    case 'out.brief_section':
    case 'out.notify':
      return cut(node.title);
    case 'out.speak':
      return cut(node.text);
  }
}
