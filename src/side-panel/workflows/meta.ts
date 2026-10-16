import {
  Bell,
  BookmarkPlus,
  Bot,
  Brain,
  CalendarClock,
  FileText,
  Globe,
  Hand,
  Inbox,
  MousePointerClick,
  Newspaper,
  Search,
  Sparkles,
  Split,
  SquareTerminal,
  Volume2,
  Wrench,
  Zap,
  AppWindow,
  Video,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { t } from '@extension/i18n';
import type { RunStatus, RunStepStatus } from '@extension/storage';
import { cronShape } from '@src/background/workflows/describe';
import { groupOf } from '@src/background/workflows/spec';
import type { NodeType, WorkflowNode, WorkflowSpec } from '@src/background/workflows/spec';

type MessageKey = Parameters<typeof t>[0];

/** How each kind of node looks: its icon and its name. */
export const NODE_META: Record<NodeType, { icon: LucideIcon; label: MessageKey }> = {
  'trigger.schedule': { icon: CalendarClock, label: 'flow_type_schedule' },
  'trigger.manual': { icon: Hand, label: 'flow_type_manual' },
  'trigger.event': { icon: Zap, label: 'flow_type_event' },
  'trigger.tab': { icon: AppWindow, label: 'flow_type_tab' },
  'step.http_get': { icon: Globe, label: 'flow_type_httpGet' },
  'step.web_search': { icon: Search, label: 'flow_type_webSearch' },
  'step.browse': { icon: MousePointerClick, label: 'flow_type_browse' },
  'step.read_page': { icon: FileText, label: 'flow_type_readPage' },
  'step.memory_search': { icon: Brain, label: 'flow_type_memorySearch' },
  'step.memory_save': { icon: BookmarkPlus, label: 'flow_type_memorySave' },
  'step.llm': { icon: Sparkles, label: 'flow_type_llm' },
  'step.condition': { icon: Split, label: 'flow_type_condition' },
  'step.agent': { icon: Bot, label: 'flow_type_agent' },
  'step.tool': { icon: Wrench, label: 'flow_type_tool' },
  'step.sandbox': { icon: SquareTerminal, label: 'flow_type_sandbox' },
  'step.meeting_join': { icon: Video, label: 'flow_type_meetingJoin' },
  'out.inbox': { icon: Inbox, label: 'flow_type_inbox' },
  'out.brief_section': { icon: Newspaper, label: 'flow_type_brief' },
  'out.notify': { icon: Bell, label: 'flow_type_notify' },
  'out.speak': { icon: Volume2, label: 'flow_type_speak' },
};

export const GROUP_LABEL: Record<ReturnType<typeof groupOf>, MessageKey> = {
  trigger: 'flow_group_trigger',
  step: 'flow_group_step',
  output: 'flow_group_output',
};

export const STATUS_LABEL: Record<RunStepStatus, MessageKey> = {
  queued: 'flow_status_queued',
  running: 'flow_status_running',
  waiting_user: 'flow_status_waiting',
  succeeded: 'flow_status_succeeded',
  failed: 'flow_status_failed',
  cancelled: 'flow_status_cancelled',
  interrupted: 'flow_status_interrupted',
  unknown_outcome: 'flow_status_unknown',
  skipped: 'flow_status_skipped',
};

/** The dot colour of a status: mint while acting or done, amber only while it waits for the user's click. */
export function statusTone(status: RunStatus | RunStepStatus | null | undefined): string {
  switch (status) {
    case 'running':
    case 'succeeded':
      return 'bg-primary';
    case 'waiting_user':
      return 'bg-hold';
    case 'failed':
    case 'unknown_outcome':
      return 'bg-destructive';
    default:
      return 'bg-muted-foreground/50';
  }
}

const WEEKDAY = (day: number) => new Date(2026, 0, 4 + day).toLocaleDateString(undefined, { weekday: 'short' });

/** A schedule in the user's language, e.g. "Every day at 07:30". */
export function scheduleText(cron: string): string {
  const shape = cronShape(cron);
  switch (shape.kind) {
    case 'daily':
      return t('flow_cron_daily', [shape.time]);
    case 'weekdays':
      return t('flow_cron_weekdays', [shape.time]);
    case 'weekly':
      return t('flow_cron_weekly', [shape.days.map(WEEKDAY).join(', '), shape.time]);
    case 'hourly':
      return t('flow_cron_hourly', [String(shape.minute).padStart(2, '0')]);
    case 'every':
      return t('flow_cron_every', [String(shape.minutes)]);
    default:
      return t('flow_cron_custom', [cron]);
  }
}

/**
 * When a workflow runs, in a few words: its schedule, the pages that start it, the event it listens for, or by hand.
 * A routine with several ways in names them all, e.g. "Every day at 07:30 · When a meeting ends".
 */
export function triggerSummary(spec: Pick<WorkflowSpec, 'nodes'>): string {
  const triggers = spec.nodes.filter(node => groupOf(node.type) === 'trigger');
  const parts: string[] = [];
  const pages = triggers.flatMap(node => (node.type === 'trigger.tab' ? [node.urlPattern] : []));
  for (const node of triggers) {
    if (node.type === 'trigger.schedule') parts.push(scheduleText(node.cron));
    if (node.type === 'trigger.event') parts.push(nodeSubtitle(node));
  }
  if (pages.length === 1) parts.push(t('flow_trigger_page', [pages[0]]));
  if (pages.length > 1) parts.push(t('flow_trigger_pages', [String(pages.length)]));
  // By hand is always possible; it is named only when nothing else starts the routine
  return [...new Set(parts)].join(' · ') || t('flow_trigger_byHand');
}

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** The second line of a node on the diagram: what it reaches or what it is told. */
export function nodeSubtitle(node: WorkflowNode): string {
  switch (node.type) {
    case 'trigger.schedule':
      return scheduleText(node.cron);
    case 'trigger.manual':
      return t('flow_trigger_byHand');
    case 'trigger.event':
      return node.event === 'meeting_ended' ? t('flow_event_meetingEnded') : t('flow_event_inboxItem');
    case 'trigger.tab':
      return node.urlPattern;
    case 'step.http_get':
    case 'step.read_page':
      return host(node.url);
    case 'step.web_search':
    case 'step.memory_search':
      return node.query;
    case 'step.browse':
    case 'step.agent':
      return node.task;
    case 'step.memory_save':
    case 'out.inbox':
    case 'out.brief_section':
    case 'out.notify':
      return node.title;
    case 'step.llm':
      return node.instructions;
    case 'step.condition':
      return `${node.left} ${node.op.replace(/_/g, ' ')} ${node.right}`.trim();
    case 'step.tool':
      return `${node.connector} · ${node.tool}`;
    case 'step.sandbox':
      return node.command;
    case 'step.meeting_join':
      return t('flow_meetingJoin_detail');
    case 'out.speak':
      return node.text;
  }
}

/** "5 min ago", "in 3 h", "yesterday": short, in the user's language. */
export function relativeTime(at: number, now = Date.now()): string {
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(seconds, 'second');
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), 'hour');
  return format.format(Math.round(seconds / 86_400), 'day');
}

/** A time to come, e.g. "Tomorrow 07:30" or "Mon 09:00". */
export function whenText(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const today = new Date(now);
  const tomorrow = new Date(now + 86_400_000);
  if (date.toDateString() === today.toDateString()) return t('flow_when_today', [time]);
  if (date.toDateString() === tomorrow.toDateString()) return t('flow_when_tomorrow', [time]);
  return `${date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

export function durationText(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export { groupOf };
