import { useState } from 'react';
import { ArrowLeft, Check, Clock, ExternalLink, X } from 'lucide-react';
import { t } from '@extension/i18n';
import type { InboxItem } from '@extension/storage';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import type { PanelApi } from '../registry';
import { HOUR_MS, tomorrowMorning } from './InboxRow';
import { openThreadId, relativeTime, sourceLabel } from './meta';
import { draftPrompt } from './whatsapp/WhatsAppView';

export interface InboxDetailProps {
  item: InboxItem;
  api: PanelApi;
  onBack: () => void;
  onAnswer: (approved: boolean) => Promise<void>;
  onMarkDone: () => void;
  onMarkUnread: () => void;
  onSnooze: (until: number) => void;
  // Opens the WhatsApp view, for items from WhatsApp
  onOpenWhatsapp?: (tab: 'catchup' | 'bulk') => void;
}

/** A link in an item's body: shown as plain text with a safe, explicit "open" action, never auto-opened. */
function LinkRow({ link }: { link: InboxItem['links'][number] }) {
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="min-w-0 truncate text-[12.5px]">{link.label || link.url}</span>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={t('inbox_link_open_a11y', [link.label || link.url])}
        onClick={() => void chrome.tabs.create({ url: link.url })}>
        <ExternalLink className="size-3.5" aria-hidden />
      </Button>
    </li>
  );
}

export default function InboxDetail({
  item,
  api,
  onBack,
  onAnswer,
  onMarkDone,
  onMarkUnread,
  onSnooze,
  onOpenWhatsapp,
}: InboxDetailProps) {
  const [busy, setBusy] = useState(false);
  const needsApproval = item.kind === 'approval' && item.status !== 'done' && item.approval;
  const threadId = openThreadId(item);

  const answer = async (approved: boolean) => {
    setBusy(true);
    try {
      await onAnswer(approved);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <Button size="sm" variant="ghost" onClick={onBack} className="self-start">
        <ArrowLeft className="size-3.5" aria-hidden />
        {t('inbox_back')}
      </Button>

      <header className="px-1">
        <div className="flex items-center gap-2">
          <Badge variant="outline">{sourceLabel(item.source)}</Badge>
          {item.priority === 'high' && (
            <Badge variant="outline" className="border-destructive/40 text-destructive">
              {t('inbox_priority_high')}
            </Badge>
          )}
        </div>
        <h1 className="mt-1.5 text-[15px] font-semibold tracking-[-0.01em]">{item.title}</h1>
        <p className="text-muted-foreground mt-0.5 text-[11.5px]">{relativeTime(item.createdAt)}</p>
      </header>

      {/* The body is from outside the extension: shown as plain text, never as markup */}
      <p className="glass whitespace-pre-wrap rounded-xl px-3 py-2.5 text-[12.5px] leading-relaxed">{item.body}</p>

      {item.links.length > 0 && (
        <ul className="glass flex flex-col gap-1.5 rounded-xl px-3 py-2">
          {item.links.map(link => (
            <LinkRow key={link.url} link={link} />
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-1.5">
        {needsApproval ? (
          <>
            <Button size="sm" variant="hold" disabled={busy} onClick={() => void answer(true)}>
              <Check className="size-3.5" aria-hidden />
              {t('inbox_action_approve')}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void answer(false)}>
              <X className="size-3.5" aria-hidden />
              {t('inbox_action_decline')}
            </Button>
          </>
        ) : (
          <>
            {item.status !== 'done' ? (
              <Button size="sm" variant="glass" onClick={onMarkDone}>
                {t('inbox_action_markDone')}
              </Button>
            ) : (
              <Button size="sm" variant="glass" onClick={onMarkUnread}>
                {t('inbox_action_markUnread')}
              </Button>
            )}
            <Button size="sm" variant="glass" onClick={() => onSnooze(Date.now() + HOUR_MS)}>
              <Clock className="size-3.5" aria-hidden />
              {t('inbox_snooze_1h')}
            </Button>
            <Button size="sm" variant="glass" onClick={() => onSnooze(tomorrowMorning())}>
              <Clock className="size-3.5" aria-hidden />
              {t('inbox_snooze_tomorrow')}
            </Button>
          </>
        )}
        {threadId && (
          <Button size="sm" variant="glass" onClick={() => api.openThread(threadId)}>
            {t('inbox_action_openChat')}
          </Button>
        )}
        {item.source === 'whatsapp-web' && (
          <Button size="sm" variant="glass" onClick={() => api.startThread(draftPrompt(item.title))}>
            {t('inbox_wa_action_draft')}
          </Button>
        )}
        {item.source === 'whatsapp-bulk' && onOpenWhatsapp && (
          <Button size="sm" variant="glass" onClick={() => onOpenWhatsapp('bulk')}>
            {t('inbox_wa_action_openBulk')}
          </Button>
        )}
        {!threadId && item.source.startsWith('workflow:') && (
          <Button size="sm" variant="glass" onClick={() => api.go('workflows')}>
            {t('inbox_action_openWorkflow')}
          </Button>
        )}
      </div>
    </div>
  );
}
