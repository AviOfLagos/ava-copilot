import { useState } from 'react';
import { FiFileText, FiGlobe, FiMessageSquare, FiTrash2 } from 'react-icons/fi';
import { PiBookmarkSimpleBold } from 'react-icons/pi';
import { t } from '@extension/i18n';
import { kbStore } from '@extension/storage';
import type { KbAnswer, KbCitation, KnowledgeItem, KnowledgeSourceType } from '@extension/storage';
import { useLive } from '../hooks/useLive';

interface KnowledgeViewProps {
  // Resolves with the answer, or rejects with a message to show
  onAsk: (question: string) => Promise<KbAnswer>;
  onSavePage: () => Promise<string>;
  onDelete: (itemId: string) => void;
  onOpenCitation: (citation: KbCitation) => void;
  isDarkMode?: boolean;
}

const TYPE_ICONS: Record<KnowledgeSourceType, typeof FiFileText> = {
  thread: FiMessageSquare,
  meeting: FiFileText,
  page: FiGlobe,
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

/**
 * The knowledge base: ask a question across past chats, meetings and saved pages and get an
 * answer whose citations open the source, save the current page, and see or remove what is in it.
 */
export default function KnowledgeView({
  onAsk,
  onSavePage,
  onDelete,
  onOpenCitation,
  isDarkMode = false,
}: KnowledgeViewProps) {
  const items = useLive(() => kbStore.items(), [], [] as KnowledgeItem[]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<KbAnswer | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  const muted = isDarkMode ? 'text-gray-400' : 'text-gray-500';
  const card = `rounded-lg border p-3 text-sm ${isDarkMode ? 'border-slate-700 bg-slate-800 text-gray-200' : 'border-sky-100 bg-white/90 text-gray-800'}`;
  const chip = `rounded px-1 text-xs font-semibold ${isDarkMode ? 'bg-sky-900 text-sky-200 hover:bg-sky-800' : 'bg-sky-100 text-sky-700 hover:bg-sky-200'}`;

  const ask = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || asking) return;
    setAsking(true);
    setNotice(null);
    try {
      setAnswer(await onAsk(text));
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setAsking(false);
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

  const byNumber = new Map(answer?.citations.map(citation => [citation.n, citation]));
  // The answer with its [n] markers as buttons that open the source
  const answerParts = answer
    ? answer.answer.split(/(\[\d+(?:\s*,\s*\d+)*\])/g).map((part, index) => {
        const numbers = part
          .match(/^\[(.+)\]$/)?.[1]
          .split(',')
          .map(n => Number(n.trim()));
        if (!numbers) return <span key={index}>{part}</span>;
        return (
          <span key={index}>
            {numbers.map(n => {
              const citation = byNumber.get(n);
              return citation ? (
                <button
                  key={n}
                  type="button"
                  className={`${chip} mx-0.5 align-super`}
                  title={`${citation.title} · ${citationText(citation)}`}
                  onClick={() => onOpenCitation(citation)}>
                  {n}
                </button>
              ) : null;
            })}
          </span>
        );
      })
    : null;

  return (
    <div className={`flex-1 space-y-3 overflow-y-auto p-2 ${isDarkMode ? 'bg-slate-900/80' : ''}`}>
      <form onSubmit={event => void ask(event)} className="flex gap-2">
        <input
          type="text"
          value={question}
          onChange={event => setQuestion(event.target.value)}
          placeholder={t('kb_ask_placeholder')}
          aria-label={t('kb_ask_placeholder')}
          className={`min-w-0 flex-1 rounded-md border px-2 py-1.5 text-sm ${isDarkMode ? 'border-slate-600 bg-slate-800 text-gray-200' : 'border-sky-200 bg-white'}`}
        />
        <button
          type="submit"
          disabled={asking || !question.trim()}
          className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50">
          {t('kb_ask_button')}
        </button>
      </form>

      {asking && <p className={`text-sm ${muted}`}>{t('kb_asking')}</p>}
      {notice && (
        <p
          role={notice.error ? 'alert' : 'status'}
          className={`rounded px-2 py-1 text-sm ${
            notice.error
              ? isDarkMode
                ? 'bg-red-950 text-red-200'
                : 'bg-red-50 text-red-700'
              : isDarkMode
                ? 'bg-emerald-950 text-emerald-200'
                : 'bg-emerald-50 text-emerald-800'
          }`}>
          {notice.text}
        </p>
      )}

      {answer && !asking && (
        <section className={card} aria-label={t('kb_answer')}>
          <p className="whitespace-pre-wrap break-words">{answerParts}</p>
          {answer.citations.length > 0 && (
            <>
              <h3 className={`mt-3 text-xs font-semibold uppercase ${muted}`}>{t('kb_sources')}</h3>
              <ol className="mt-1 space-y-1">
                {[...answer.citations]
                  .sort((a, b) => a.n - b.n)
                  .map(citation => (
                    <li key={citation.n}>
                      <button
                        type="button"
                        onClick={() => onOpenCitation(citation)}
                        className="text-left hover:underline">
                        <span className={`${chip} mr-1`}>{citation.n}</span>
                        <span className="font-medium">{citation.title}</span>
                        <span className={muted}> · {citationText(citation)}</span>
                      </button>
                    </li>
                  ))}
              </ol>
            </>
          )}
        </section>
      )}

      <div className="flex items-center justify-between">
        <h3 className={`text-sm font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`}>
          {t('kb_items', [String(items.length)])}
        </h3>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-50 ${isDarkMode ? 'border-slate-600 text-sky-300 hover:bg-slate-800' : 'border-sky-200 bg-white text-sky-700 hover:bg-sky-50'}`}>
          <PiBookmarkSimpleBold size={14} />
          {saving ? t('kb_saving') : t('kb_savePage')}
        </button>
      </div>

      {items.length === 0 ? (
        <p className={`text-sm ${muted}`}>{t('kb_empty')}</p>
      ) : (
        <ul aria-label={t('kb_title')} className="space-y-1">
          {items.map(item => {
            const Icon = TYPE_ICONS[item.sourceType];
            return (
              <li key={item.id} className={`${card} flex items-center gap-2 py-2`}>
                <Icon size={16} className={`shrink-0 ${muted}`} aria-label={t(TYPE_LABELS[item.sourceType])} />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() =>
                    onOpenCitation({
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
                    })
                  }>
                  <span className="block truncate font-medium">{item.title}</span>
                  <span className={`block text-xs ${muted}`}>
                    {t(TYPE_LABELS[item.sourceType])} · {shortDate(item.sourceDate)}
                    {item.unembedded > 0 && ` · ${t('kb_keywordOnly')}`}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(item.id)}
                  className={`shrink-0 rounded p-1 ${isDarkMode ? 'text-gray-400 hover:bg-slate-700' : 'text-gray-500 hover:bg-gray-100'}`}
                  aria-label={t('kb_delete', [item.title])}
                  title={t('kb_delete', [item.title])}>
                  <FiTrash2 size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
