import { useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { BookmarkPlus, FileText, Globe, MessageSquare, Trash2 } from 'lucide-react';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import { kbStore } from '@extension/storage';
import type { KbAnswer, KbCitation, KnowledgeItem, KnowledgeSourceType } from '@extension/storage';
import { useLive } from '../hooks/useLive';
import MorphOrb from '../components/ui/morph-orb';
import type { MorphOrbPhase } from '../components/ui/morph-orb';
import { Button } from '../components/ui/button';

interface KnowledgeViewProps {
  // Resolves with the answer, or rejects with a message to show
  onAsk: (question: string) => Promise<KbAnswer>;
  onSavePage: () => Promise<string>;
  onDelete: (itemId: string) => void;
  onOpenCitation: (citation: KbCitation) => void;
  isDarkMode?: boolean;
}

const TYPE_ICONS: Record<KnowledgeSourceType, LucideIcon> = {
  thread: MessageSquare,
  meeting: FileText,
  page: Globe,
};

const TYPE_LABELS = {
  thread: 'kb_type_thread',
  meeting: 'kb_type_meeting',
  page: 'kb_type_page',
} as const;

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Where a citation points, as the user reads it: "Meeting · Sep 29 · 12:04". */
export function citationText(citation: KbCitation): string {
  const place = citation.label === 'note' ? t('kb_place_note') : citation.label;
  return [t(TYPE_LABELS[citation.sourceType]), shortDate(citation.date), citation.sourceType === 'page' ? '' : place]
    .filter(Boolean)
    .join(' · ');
}

function itemCitation(item: KnowledgeItem): KbCitation {
  return {
    n: 0,
    sourceType: item.sourceType,
    title: item.title,
    label: '',
    date: item.sourceDate,
    url: item.url,
    anchor:
      item.sourceType === 'thread'
        ? { kind: 'thread', threadId: item.sourceId, seq: 0 }
        : item.sourceType === 'meeting'
          ? { kind: 'meeting', meetingId: item.sourceId, t: -1 }
          : { kind: 'page', url: item.url },
  };
}

/**
 * Memory: ask across past chats, meetings and saved pages, and see or remove what is in it. A
 * question takes MorphOrb's path: the pill becomes a dotted orb while it searches, then unfolds
 * into the answer, with the sources it cites underneath.
 */
export default function KnowledgeView({ onAsk, onSavePage, onDelete, onOpenCitation }: KnowledgeViewProps) {
  const items = useLive(() => kbStore.items(), [], [] as KnowledgeItem[]);
  const [tab, setTab] = useState<'ask' | 'items'>('ask');
  const [phase, setPhase] = useState<MorphOrbPhase>('idle');
  const [citations, setCitations] = useState<KbCitation[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const askedRef = useRef(0);

  const ask = async (question: string) => {
    const mine = ++askedRef.current;
    setCitations([]);
    try {
      const result = await onAsk(question);
      if (mine === askedRef.current) setCitations(result.citations);
      return result.answer;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      setNotice({ text: t('kb_saved', [await onSavePage()]), error: false });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setSaving(false);
    }
  };

  const tabButton = (id: 'ask' | 'items', label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      className={cn(
        'h-7 rounded-[9px] px-3 text-[12px] transition-colors',
        tab === id ? 'border bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}>
      {label}
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5">
        <div role="tablist" aria-label={t('kb_title')} className="glass flex gap-0.5 rounded-xl p-0.5">
          {tabButton('ask', t('kb_tab_ask'))}
          {tabButton('items', t('kb_items', [String(items.length)]))}
        </div>
        <Button variant="glass" size="sm" onClick={() => void save()} disabled={saving}>
          <BookmarkPlus className="size-3.5" />
          {saving ? t('kb_saving') : t('kb_savePage')}
        </Button>
      </div>

      {notice && (
        <p
          role={notice.error ? 'alert' : 'status'}
          className={cn(
            'mx-3 mt-2 rounded-xl border px-3 py-2 text-[12.5px]',
            notice.error ? 'border-destructive/40 bg-destructive/10' : 'border-primary/40 bg-primary/10',
          )}>
          {notice.text}
        </p>
      )}

      {tab === 'ask' ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <MorphOrb
            className="flex-1"
            onSubmit={ask}
            onPhase={setPhase}
            copy={{
              placeholder: t('kb_ask_placeholder'),
              send: t('kb_ask_button'),
              labels: [t('kb_think_searching'), t('kb_think_reading'), t('kb_think_weighing'), t('kb_think_writing')],
              done: t('kb_think_done'),
              answerTitle: t('kb_answer'),
              reset: t('kb_ask_again'),
              empty: t('kb_answer_nothing'),
            }}
          />
          {phase === 'answered' && citations.length > 0 && (
            <section
              aria-label={t('kb_sources')}
              className="animate-in fade-in-0 slide-in-from-top-2 absolute inset-x-3 top-3">
              <h3 className="label-mono mb-1.5">{t('kb_sources')}</h3>
              <ol className="flex flex-col gap-1">
                {[...citations]
                  .sort((a, b) => a.n - b.n)
                  .map(citation => (
                    <li key={citation.n}>
                      <button
                        type="button"
                        onClick={() => onOpenCitation(citation)}
                        className="glass hover:bg-accent flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[12px]">
                        <span className="bg-primary/15 text-primary flex size-5 shrink-0 items-center justify-center rounded-md font-mono text-[10.5px]">
                          {citation.n}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-medium">{citation.title}</span>
                          <span className="text-muted-foreground"> · {citationText(citation)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
              </ol>
            </section>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {items.length === 0 ? (
            <p className="text-muted-foreground text-[13px]">{t('kb_empty')}</p>
          ) : (
            <ul aria-label={t('kb_title')} className="flex flex-col gap-1.5">
              {items.map(item => {
                const Icon = TYPE_ICONS[item.sourceType];
                return (
                  <li key={item.id} className="glass flex items-center gap-2.5 rounded-xl px-3 py-2">
                    <Icon className="text-primary size-4 shrink-0" aria-label={t(TYPE_LABELS[item.sourceType])} />
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => onOpenCitation(itemCitation(item))}>
                      <span className="block truncate text-[13px] font-medium">{item.title}</span>
                      <span className="text-muted-foreground block font-mono text-[10.5px]">
                        {t(TYPE_LABELS[item.sourceType])} · {shortDate(item.sourceDate)}
                        {item.unembedded > 0 && ` · ${t('kb_keywordOnly')}`}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onDelete(item.id)}
                      aria-label={t('kb_delete', [item.title])}
                      title={t('kb_delete', [item.title])}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
