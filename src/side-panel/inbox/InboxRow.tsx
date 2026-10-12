import { useState } from 'react';
import { Check, Clock, MoreHorizontal, X } from 'lucide-react';
import { t } from '@extension/i18n';
import type { InboxItem } from '@extension/storage';
import { cn } from '@extension/ui';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { RowMenu, RowMenuContent, RowMenuItem, RowMenuTrigger } from '../components/ui/row-menu';
import { priorityTone, relativeTime, sourceIcon, sourceLabel } from './meta';

export interface InboxRowProps {
  item: InboxItem;
  onOpen: () => void;
  onAnswer: (approved: boolean) => Promise<void>;
  onMarkDone: () => void;
  onMarkUnread: () => void;
  onSnooze: (until: number) => void;
}

const HOUR_MS = 60 * 60 * 1000;
const tomorrowMorning = () => {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
};

/** One row: source icon, title, time, priority, and — for an unanswered approval — inline buttons. */
export default function InboxRow({ item, onOpen, onAnswer, onMarkDone, onMarkUnread, onSnooze }: InboxRowProps) {
  const [busy, setBusy] = useState(false);
  const Icon = sourceIcon(item.source);
  const needsApproval = item.kind === 'approval' && item.status !== 'done' && item.approval;

  const answer = async (approved: boolean) => {
    setBusy(true);
    try {
      await onAnswer(approved);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className={cn(
        'glass flex items-start gap-2.5 rounded-xl px-3 py-2.5 transition-colors',
        item.status === 'unread' && 'border-primary/30',
      )}>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
        aria-label={`${item.title}, ${sourceLabel(item.source)}`}>
        <span className={cn('mt-[7px] size-2 shrink-0 rounded-full', priorityTone(item))} aria-hidden />
        <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className={cn('truncate text-[13px]', item.status === 'unread' ? 'font-semibold' : 'font-medium')}>
              {item.title}
            </span>
            {item.digestCount ? <Badge variant="secondary">{item.digestCount}</Badge> : null}
            {item.status === 'snoozed' && <Badge variant="outline">{t('inbox_status_snoozed')}</Badge>}
          </span>
          <span className="text-muted-foreground mt-0.5 block truncate text-[11.5px]">
            {sourceLabel(item.source)} · {relativeTime(item.createdAt)}
          </span>
        </span>
      </button>

      {needsApproval ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="hold" disabled={busy} onClick={() => void answer(true)}>
            <Check className="size-3.5" aria-hidden />
            {t('inbox_action_approve')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void answer(false)}>
            <X className="size-3.5" aria-hidden />
            {t('inbox_action_decline')}
          </Button>
        </span>
      ) : (
        <RowMenu>
          <RowMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={t('inbox_row_menu_a11y')}>
              <MoreHorizontal className="size-4" aria-hidden />
            </Button>
          </RowMenuTrigger>
          <RowMenuContent>
            {item.status !== 'done' ? (
              <RowMenuItem onSelect={onMarkDone}>{t('inbox_action_markDone')}</RowMenuItem>
            ) : (
              <RowMenuItem onSelect={onMarkUnread}>{t('inbox_action_markUnread')}</RowMenuItem>
            )}
            <RowMenuItem onSelect={() => onSnooze(Date.now() + HOUR_MS)}>
              <Clock className="size-3.5" aria-hidden />
              {t('inbox_snooze_1h')}
            </RowMenuItem>
            <RowMenuItem onSelect={() => onSnooze(tomorrowMorning())}>
              <Clock className="size-3.5" aria-hidden />
              {t('inbox_snooze_tomorrow')}
            </RowMenuItem>
          </RowMenuContent>
        </RowMenu>
      )}
    </li>
  );
}

// Re-exported so InboxDetail can offer the same snooze presets without duplicating the math
export { HOUR_MS, tomorrowMorning };
