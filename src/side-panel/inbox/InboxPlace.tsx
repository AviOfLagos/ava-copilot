import { useEffect, useMemo, useState } from 'react';
import { t } from '@extension/i18n';
import { db, workspaceStore } from '@extension/storage';
import type { AgentProfile, InboxItem, Workspace } from '@extension/storage';
import { useLive } from '../hooks/useLive';
import type { PanelApi } from '../registry';
import InboxDetail from './InboxDetail';
import InboxRow from './InboxRow';
import { sourceLabel, sourcesOf } from './meta';

/** The user's workspaces, kept current as settings change them. Local to this place: see meta.ts. */
function useWorkspaceNames(): Workspace[] {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  useEffect(() => {
    const load = () => void workspaceStore.list().then(setWorkspaces);
    load();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.workspaces) load();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);
  return workspaces;
}

type StatusFilter = 'all' | 'unread' | 'approvals';
const ALL = 'all';

function matches(item: InboxItem, status: StatusFilter, source: string, workspace: string, agent: string): boolean {
  if (status === 'unread' && item.status !== 'unread') return false;
  if (status === 'approvals' && !(item.kind === 'approval' && item.status !== 'done')) return false;
  if (source !== ALL && item.source !== source) return false;
  if (workspace !== ALL && (item.workspaceId ?? '') !== workspace) return false;
  if (agent !== ALL && (item.agentId ?? '') !== agent) return false;
  return true;
}

function FilterChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        active
          ? 'bg-primary/15 border-primary/50 text-foreground rounded-full border px-2.5 py-1 text-[11.5px] font-medium'
          : 'glass text-muted-foreground rounded-full px-2.5 py-1 text-[11.5px]'
      }>
      {label}
    </button>
  );
}

function FilterSelect({
  value,
  onChange,
  options,
  allLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  allLabel: string;
}) {
  if (options.length === 0) return null;
  return (
    <select
      value={value}
      onChange={event => onChange(event.target.value)}
      className="bg-secondary text-secondary-foreground rounded-full px-2.5 py-1 text-[11.5px]">
      <option value={ALL}>{allLabel}</option>
      {options.map(option => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** The Inbox place: filters over the list, or one item open on its own. */
export default function InboxPlace({ api }: { api: PanelApi }) {
  const items = useLive(() => db.inbox.toArray(), [], [] as InboxItem[]);
  const agents = useLive(() => db.agents.toArray(), [], [] as AgentProfile[]);
  const workspaces = useWorkspaceNames();

  const [status, setStatus] = useState<StatusFilter>('all');
  const [source, setSource] = useState(ALL);
  const [workspace, setWorkspace] = useState(ALL);
  const [agent, setAgent] = useState(ALL);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(
    () =>
      items
        .filter(item => matches(item, status, source, workspace, agent))
        .sort((a, b) => Number(a.status !== 'unread') - Number(b.status !== 'unread') || b.createdAt - a.createdAt),
    [items, status, source, workspace, agent],
  );
  const unreadTotal = useMemo(() => items.filter(item => item.status === 'unread').length, [items]);
  const openItem = openId ? (items.find(item => item.id === openId) ?? null) : null;

  const workspaceUsed = useMemo(() => new Set(items.map(item => item.workspaceId).filter(Boolean)), [items]);
  const agentUsed = useMemo(() => new Set(items.map(item => item.agentId).filter(Boolean)), [items]);

  const answer = async (item: InboxItem, approved: boolean) => {
    if (!item.approval) return;
    setError(null);
    try {
      await api.request({ type: 'inbox_answer', approvalRequestId: item.approval.requestId, approved });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  };
  const markRead = (item: InboxItem) => api.post({ type: 'inbox_mark_read', id: item.id });
  const markDone = (item: InboxItem) => api.post({ type: 'inbox_mark_done', id: item.id });
  const markUnread = (item: InboxItem) => api.post({ type: 'inbox_mark_unread', id: item.id });
  const snooze = (item: InboxItem, until: number) => api.post({ type: 'inbox_snooze', id: item.id, until });
  const openItemRow = (item: InboxItem) => {
    setOpenId(item.id);
    if (item.status === 'unread') markRead(item);
  };

  if (openItem) {
    return (
      <InboxDetail
        item={openItem}
        api={api}
        onBack={() => setOpenId(null)}
        onAnswer={approved => answer(openItem, approved)}
        onMarkDone={() => markDone(openItem)}
        onMarkUnread={() => markUnread(openItem)}
        onSnooze={until => snooze(openItem, until)}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <header className="px-1">
        <h1 className="text-[15px] font-semibold tracking-[-0.01em]">{t('inbox_title')}</h1>
        <p className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">
          {unreadTotal > 0 ? t('inbox_intro_unread', [String(unreadTotal)]) : t('inbox_intro_clear')}
        </p>
      </header>

      {error && (
        <div role="alert" className="border-destructive/40 bg-destructive/10 rounded-xl border px-3 py-2 text-[12.5px]">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip active={status === 'all'} label={t('inbox_filter_all')} onClick={() => setStatus('all')} />
        <FilterChip active={status === 'unread'} label={t('inbox_filter_unread')} onClick={() => setStatus('unread')} />
        <FilterChip
          active={status === 'approvals'}
          label={t('inbox_filter_approvals')}
          onClick={() => setStatus('approvals')}
        />
        <FilterSelect
          value={source}
          onChange={setSource}
          allLabel={t('inbox_filter_source_all')}
          options={sourcesOf(items).map(value => ({ value, label: sourceLabel(value) }))}
        />
        <FilterSelect
          value={workspace}
          onChange={setWorkspace}
          allLabel={t('inbox_filter_workspace_all')}
          options={workspaces
            .filter(item => workspaceUsed.has(item.id))
            .map(item => ({ value: item.id, label: item.name }))}
        />
        <FilterSelect
          value={agent}
          onChange={setAgent}
          allLabel={t('inbox_filter_agent_all')}
          options={agents.filter(item => agentUsed.has(item.id)).map(item => ({ value: item.id, label: item.name }))}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="glass rounded-2xl px-4 py-5">
          <p className="text-[13px] font-medium">{t('inbox_empty_title')}</p>
          <p className="text-muted-foreground mt-1.5 text-[12.5px] leading-relaxed">{t('inbox_empty_body')}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {filtered.map(item => (
            <InboxRow
              key={item.id}
              item={item}
              onOpen={() => openItemRow(item)}
              onAnswer={approved => answer(item, approved)}
              onMarkDone={() => markDone(item)}
              onMarkUnread={() => markUnread(item)}
              onSnooze={until => snooze(item, until)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
