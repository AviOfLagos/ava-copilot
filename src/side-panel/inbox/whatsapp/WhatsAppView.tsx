import { useEffect, useState } from 'react';
import { ArrowLeft, MessageCircle, RefreshCw, Sparkles } from 'lucide-react';
import { t } from '@extension/i18n';
import { db, inboxSettingsStore } from '@extension/storage';
import type { InboxItem, InboxSettingsConfig } from '@extension/storage';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { useLive } from '../../hooks/useLive';
import type { PanelApi } from '../../registry';
import { relativeTime } from '../meta';
import BulkCompose from './BulkCompose';
import BulkRunView from './BulkRunView';
import { counts, useBulkRuns } from './useBulk';

type Tab = 'catchup' | 'bulk';

export function SneakPeek() {
  return (
    <Badge variant="call" className="font-sans">
      <Sparkles className="size-3" aria-hidden />
      {t('inbox_wa_sneakPeek')}
    </Badge>
  );
}

/** The chat prompt that drafts a reply to one WhatsApp chat, for the user to finish and send. */
export function draftPrompt(chat: string): string {
  return t('inbox_wa_prompt_reply', [chat]);
}

function CatchUpTab({ api }: { api: PanelApi }) {
  const items = useLive(() => db.inbox.filter(item => item.source === 'whatsapp-web').toArray(), [], [] as InboxItem[]);
  const [watching, setWatching] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    void inboxSettingsStore.getSettings().then((settings: InboxSettingsConfig) => setWatching(settings.watchWhatsapp));
  }, []);
  const open = items.filter(item => item.status !== 'done').sort((a, b) => b.createdAt - a.createdAt);

  const checkNow = async () => {
    setChecking(true);
    setMessage(null);
    try {
      const reply = await api.request<{ added?: number }>({ type: 'inbox_watch_now' }, 30_000);
      setMessage(t('inbox_wa_catchup_checked', [String(reply.added ?? 0)]));
    } catch (problem) {
      setMessage(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-[12.5px] leading-relaxed">{t('inbox_wa_catchup_intro')}</p>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" onClick={() => api.startThread(t('inbox_wa_prompt_catchUp'))}>
          <Sparkles className="size-3.5" aria-hidden />
          {t('inbox_wa_catchup_ask')}
        </Button>
        {watching && (
          <Button size="sm" variant="glass" disabled={checking} onClick={() => void checkNow()}>
            <RefreshCw className="size-3.5" aria-hidden />
            {t('inbox_wa_catchup_check')}
          </Button>
        )}
      </div>
      {watching === false && (
        <p className="glass rounded-xl px-3 py-2 text-[12px] leading-relaxed">{t('inbox_wa_catchup_watchOff')}</p>
      )}
      {message && <p className="text-muted-foreground text-[11.5px]">{message}</p>}
      {open.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label={t('inbox_wa_catchup_list')}>
          {open.map(item => (
            <li key={item.id} className="glass flex items-start gap-2 rounded-xl px-3 py-2">
              <MessageCircle className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline justify-between gap-2 text-[12.5px] font-medium">
                  <span className="truncate">{item.title}</span>
                  <span className="text-muted-foreground shrink-0 text-[10.5px] font-normal">
                    {relativeTime(item.createdAt)}
                  </span>
                </p>
                <p className="text-muted-foreground line-clamp-2 text-[12px]">{item.body}</p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="-ml-2 mt-0.5"
                  onClick={() => api.startThread(draftPrompt(item.title))}>
                  {t('inbox_wa_action_draft')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BulkTab({ api }: { api: PanelApi }) {
  const runs = useBulkRuns();
  const [shownId, setShownId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const open = runs.find(run => ['awaiting_approval', 'running', 'paused', 'waiting_tab'].includes(run.status));
  // A batch that just ended stays on screen with its report until the user starts a new one
  const openId = open?.id;
  useEffect(() => {
    if (openId) {
      setShownId(openId);
      setComposing(false);
    }
  }, [openId]);
  const shown = open ?? (shownId ? runs.find(run => run.id === shownId) : undefined);
  const past = runs.filter(run => ['done', 'stopped'].includes(run.status));

  if (shown && !composing) {
    return (
      <BulkRunView
        run={shown}
        api={api}
        onNew={() => {
          setShownId(null);
          setComposing(true);
        }}
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <BulkCompose api={api} />
      {past.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-[12.5px] font-medium">{t('inbox_wa_reports_title')}</h3>
          <ul className="flex flex-col gap-1">
            {past.map(run => {
              const tally = counts(run);
              return (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setComposing(false);
                      setShownId(run.id);
                    }}
                    className="glass hover:bg-accent flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-[12px]">
                    <span>{relativeTime(run.createdAt)}</span>
                    <span className="text-muted-foreground">
                      {t('inbox_wa_reports_line', [String(tally.sent), String(tally.failed), String(tally.skipped)])}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

/** WhatsApp in the Inbox: catch up with Ava, or send one message to many with one approval. */
export default function WhatsAppView({
  api,
  onBack,
  initialTab = 'catchup',
}: {
  api: PanelApi;
  onBack: () => void;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <Button size="sm" variant="ghost" onClick={onBack} className="self-start">
        <ArrowLeft className="size-3.5" aria-hidden />
        {t('inbox_back')}
      </Button>
      <header className="flex items-center gap-2 px-1">
        <h1 className="text-[15px] font-semibold tracking-[-0.01em]">{t('inbox_wa_title')}</h1>
        <SneakPeek />
      </header>
      <div role="tablist" aria-label={t('inbox_wa_title')} className="glass flex gap-1 self-start rounded-full p-1">
        {(['catchup', 'bulk'] as Tab[]).map(id => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={
              tab === id
                ? 'bg-primary/15 text-foreground rounded-full px-3 py-1 text-[12px] font-medium'
                : 'text-muted-foreground hover:text-foreground rounded-full px-3 py-1 text-[12px]'
            }>
            {id === 'catchup' ? t('inbox_wa_tab_catchup') : t('inbox_wa_tab_bulk')}
          </button>
        ))}
      </div>
      <div role="tabpanel">{tab === 'catchup' ? <CatchUpTab api={api} /> : <BulkTab api={api} />}</div>
    </div>
  );
}
