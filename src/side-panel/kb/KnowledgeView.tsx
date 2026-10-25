import { useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { BookmarkPlus, Bot, Ear, FileText, Globe, MessageSquare, StickyNote, Trash2 } from 'lucide-react';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import WorkspacePicker from '../workspaces/WorkspacePicker';
import AgentPicker from './AgentPicker';
import GraphView from './GraphView';
import WorkspaceSummaryView from '../history/WorkspaceSummaryView';
import { db, kbStore } from '@extension/storage';
import type { AgentProfile, GraphNode } from '@extension/storage';
import { ScopeActions, ScopeBadge } from './MemoryScope';
import type { KbAnswer, KbCitation, KnowledgeItem, KnowledgeSourceType } from '@extension/storage';
import { useLive } from '../hooks/useLive';
import MorphOrb from '../components/ui/morph-orb';
import type { MorphOrbPhase } from '../components/ui/morph-orb';
import { Button } from '../components/ui/button';

interface KnowledgeViewProps {
  // Resolves with the answer, or rejects with a message to show. agentId is a later, optional
  // argument so existing callers that only wire workspaceId keep type-checking; wiring it through to
  // the kb_ask message is tracked separately (see docs/task.md).
  onAsk: (question: string, workspaceId: string | null, agentId: string | null) => Promise<KbAnswer>;
  onSavePage: (workspaceId: string | null, agentId: string | null) => Promise<string>;
  onDelete: (itemId: string) => void;
  onOpenCitation: (citation: KbCitation) => void;
  onOpenSource: (node: GraphNode) => void;
  isDarkMode?: boolean;
}

const TYPE_ICONS: Record<KnowledgeSourceType, LucideIcon> = {
  thread: MessageSquare,
  meeting: FileText,
  page: Globe,
  note: StickyNote,
  'ai-session': Bot,
  ambient: Ear,
};

const TYPE_LABELS = {
  thread: 'kb_type_thread',
  meeting: 'kb_type_meeting',
  page: 'kb_type_page',
  note: 'kb_type_note',
  'ai-session': 'history_type_session',
  ambient: 'ambient_kb_type',
} as const;

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Where a citation points, as the user reads it: "Meeting · Sep 29 · 12:04". */
export function citationText(citation: KbCitation): string {
  const place = citation.label === 'note' ? t('kb_place_note') : citation.label;
  return [
    t(TYPE_LABELS[citation.sourceType]),
    shortDate(citation.date),
    ['page', 'note', 'ai-session'].includes(citation.sourceType) ? '' : place,
  ]
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
          : item.sourceType === 'note' || item.sourceType === 'ai-session'
            ? { kind: 'note', itemId: item.id }
            : { kind: 'page', url: item.url },
  };
}

/**
 * Memory: ask across past chats, meetings and saved pages, and see or remove what is in it. A
 * question takes MorphOrb's path: the pill becomes a dotted orb while it searches, then unfolds
 * into the answer, with the sources it cites underneath.
 */
export default function KnowledgeView({
  onAsk,
  onSavePage,
  onDelete,
  onOpenCitation,
  onOpenSource,
  isDarkMode,
}: KnowledgeViewProps) {
  const allItems = useLive(() => kbStore.items(), [], [] as KnowledgeItem[]);
  const agents = useLive(() => db.agents.toArray(), [], [] as AgentProfile[]);
  const agentName = (id?: string | null) => agents.find(agent => agent.id === id)?.name;
  // One workspace's knowledge, with what belongs to none; all of it when none is picked
  const [workspace, setWorkspace] = useState<string | null>(null);
  // Same idea for the agent whose work it is; the picker itself hides when there are no agents yet
  // An agent's page links here already filtered to that agent (a one-time hand-over in session storage)
  const [agent, setAgent] = useState<string | null>(() => {
    try {
      const id = sessionStorage.getItem('avi.kb.agentFilter');
      sessionStorage.removeItem('avi.kb.agentFilter');
      return id;
    } catch {
      return null;
    }
  });
  const items = allItems.filter(
    item => (!workspace || !item.workspaceId || item.workspaceId === workspace) && (!agent || item.agentId === agent),
  );
  const [tab, setTab] = useState<'ask' | 'summary' | 'items' | 'graph'>('ask');
  const [phase, setPhase] = useState<MorphOrbPhase>('idle');
  const [citations, setCitations] = useState<KbCitation[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const askedRef = useRef(0);

  const ask = async (question: string) => {
    const mine = ++askedRef.current;
    setCitations([]);
    try {
      const result = await onAsk(question, workspace, agent);
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
      setNotice({ text: t('kb_saved', [await onSavePage(workspace, agent)]), error: false });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setSaving(false);
    }
  };

  const tabButton = (id: 'ask' | 'summary' | 'items' | 'graph', label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      className={cn(
        'h-7 whitespace-nowrap rounded-[9px] px-3 text-[12px] transition-colors',
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
          {tabButton('summary', t('history_tab_summary'))}
          {tabButton('items', t('kb_items', [String(items.length)]))}
          {tabButton('graph', t('graph_tab'))}
        </div>
        {/* An icon, so four tabs and it fit the narrow panel; the name says what it does */}
        <Button
          variant="glass"
          size="icon"
          className="shrink-0"
          onClick={() => void save()}
          disabled={saving}
          aria-label={saving ? t('kb_saving') : t('kb_savePage')}
          title={saving ? t('kb_saving') : t('kb_savePage')}>
          <BookmarkPlus className="size-4" />
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5 px-3 pt-2">
        <WorkspacePicker
          value={workspace}
          onChange={setWorkspace}
          emptyLabel={t('workspace_all')}
          className="max-w-[70%]"
        />
        <AgentPicker workspaceId={workspace} value={agent} onChange={setAgent} className="max-w-[45%]" />
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

      {tab === 'summary' ? (
        <WorkspaceSummaryView workspaceId={workspace} onPick={setWorkspace} />
      ) : tab === 'graph' ? (
        <GraphView workspaceId={workspace} agentId={agent} onOpenSource={onOpenSource} isDarkMode={isDarkMode} />
      ) : tab === 'ask' ? (
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
                    <ScopeBadge item={item} agentName={agentName(item.agentId)} />
                    <ScopeActions item={item} withDelete={false} />
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
