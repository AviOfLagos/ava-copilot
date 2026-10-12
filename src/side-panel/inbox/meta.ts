import { Bot, Hash, Mail, MessageCircle, Settings2, Workflow } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { InboxItem } from '@extension/storage';

/**
 * Small, pure helpers for the Inbox place: kept local to this stream rather than imported from
 * workflows/kb (which have their own near-identical `relativeTime`), so this place has no dependency
 * on another stream's files.
 */

/** "5 min ago", "in 3 h", "yesterday": short, in the user's language. */
export function relativeTime(at: number, now: number = Date.now()): string {
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(seconds, 'second');
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), 'hour');
  return format.format(Math.round(seconds / 86_400), 'day');
}

/** A short, human label for a source id. */
export function sourceLabel(source: string): string {
  if (source === 'whatsapp-web') return 'WhatsApp';
  if (source === 'slack-web') return 'Slack';
  if (source === 'gmail-web') return 'Gmail';
  if (source.startsWith('workflow:')) return 'Workflow';
  if (source.startsWith('agent:')) return 'Agent';
  if (source === 'system') return 'System';
  return source;
}

export function sourceIcon(source: string): LucideIcon {
  if (source === 'whatsapp-web') return MessageCircle;
  if (source === 'slack-web') return Hash;
  if (source === 'gmail-web') return Mail;
  if (source.startsWith('workflow:')) return Workflow;
  if (source.startsWith('agent:')) return Bot;
  return Settings2;
}

/** The dot colour for a priority, amber only ever meaning "waits for your click" (an approval). */
export function priorityTone(item: InboxItem): string {
  if (item.kind === 'approval' && item.status !== 'done') return 'bg-hold';
  if (item.priority === 'high') return 'bg-destructive';
  return 'bg-muted-foreground/50';
}

/** The thread id an "open_thread" approval carries in its request id, or null for anything else. */
export function openThreadId(item: InboxItem): string | null {
  const requestId = item.approval?.requestId;
  if (item.approval?.action !== 'open_thread' || !requestId?.startsWith('thread:')) return null;
  return requestId.slice('thread:'.length) || null;
}

/** Every distinct source already in the list, for the source filter. */
export function sourcesOf(items: InboxItem[]): string[] {
  return [...new Set(items.map(item => item.source))].sort();
}
