import { useState } from 'react';
import { FiArchive, FiEdit2, FiTrash2 } from 'react-icons/fi';
import { BsPin, BsPinFill } from 'react-icons/bs';
import { t } from '@extension/i18n';
import { threadStore } from '@extension/storage';
import type { ThreadRecord } from '@extension/storage';
import { useLive } from '../hooks/useLive';

interface ThreadListProps {
  activeThreadId: string | null;
  onSelect: (threadId: string) => void;
  onDelete: (threadId: string) => void;
  isDarkMode?: boolean;
}

function timeAgo(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return t('threads_time_now');
  if (minutes < 60) return t('threads_time_minutes', [String(minutes)]);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('threads_time_hours', [String(hours)]);
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function StatusDot({ thread }: { thread: Pick<ThreadRecord, 'status'> }) {
  const styles = {
    idle: 'bg-gray-300',
    running: 'animate-pulse bg-sky-500',
    waiting_confirm: 'bg-amber-500',
    error: 'bg-red-500',
  } as const;
  const labels = {
    idle: 'threads_status_idle',
    running: 'threads_status_running',
    waiting_confirm: 'threads_status_waiting',
    error: 'threads_status_error',
  } as const;
  return (
    <span
      role="img"
      aria-label={t(labels[thread.status])}
      title={t(labels[thread.status])}
      className={`inline-block size-2.5 shrink-0 rounded-full ${styles[thread.status]}`}
    />
  );
}

/**
 * Every thread, pinned first, with search, rename, pin, archive and delete.
 */
export default function ThreadList({ activeThreadId, onSelect, onDelete, isDarkMode = false }: ThreadListProps) {
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const threads = useLive(() => threadStore.list({ archived: showArchived, search }), [showArchived, search], []);

  const muted = isDarkMode ? 'text-gray-400' : 'text-gray-500';
  const iconButton = `rounded p-1 ${isDarkMode ? 'text-gray-400 hover:bg-slate-700 hover:text-gray-200' : 'text-gray-500 hover:bg-sky-100 hover:text-gray-800'}`;

  const saveRename = async () => {
    if (renaming && renaming.title.trim()) {
      await threadStore.rename(renaming.id, renaming.title);
    }
    setRenaming(null);
  };

  return (
    <div className="flex h-full flex-col p-3">
      <input
        type="search"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder={t('threads_search_placeholder')}
        aria-label={t('threads_search_placeholder')}
        className={`mb-2 w-full rounded-md border px-3 py-1.5 text-sm ${isDarkMode ? 'border-slate-600 bg-slate-800 text-gray-200' : 'border-sky-100 bg-white text-gray-800'}`}
      />
      <ul className="flex-1 space-y-1 overflow-y-auto">
        {threads.length === 0 && <li className={`p-2 text-sm ${muted}`}>{t('threads_empty')}</li>}
        {threads.map(thread => (
          <li
            key={thread.id}
            className={`group rounded-md px-2 py-1.5 ${thread.id === activeThreadId ? (isDarkMode ? 'bg-slate-700' : 'bg-sky-100') : isDarkMode ? 'hover:bg-slate-800' : 'hover:bg-white/70'}`}>
            {renaming?.id === thread.id ? (
              <input
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                value={renaming.title}
                aria-label={t('threads_action_rename')}
                onChange={e => setRenaming({ id: thread.id, title: e.target.value })}
                onBlur={saveRename}
                onKeyDown={e => {
                  if (e.key === 'Enter') void saveRename();
                  if (e.key === 'Escape') setRenaming(null);
                }}
                className={`w-full rounded border px-2 py-1 text-sm ${isDarkMode ? 'border-slate-500 bg-slate-800 text-gray-200' : 'border-sky-200 bg-white'}`}
              />
            ) : confirmDelete === thread.id ? (
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className={isDarkMode ? 'text-red-300' : 'text-red-600'}>
                  {t('threads_action_confirmDelete')}
                </span>
                <span className="flex gap-1">
                  <button
                    type="button"
                    className="rounded bg-red-600 px-2 py-0.5 text-white"
                    onClick={() => onDelete(thread.id)}>
                    {t('threads_action_delete')}
                  </button>
                  <button type="button" className={iconButton} onClick={() => setConfirmDelete(null)}>
                    {t('threads_action_keep')}
                  </button>
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <StatusDot thread={thread} />
                <button
                  type="button"
                  onClick={() => onSelect(thread.id)}
                  className={`min-w-0 flex-1 text-left text-sm ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
                  <span className="block truncate font-medium">{thread.title || t('threads_untitled')}</span>
                  <span className={`text-xs ${muted}`}>{timeAgo(thread.updatedAt)}</span>
                </button>
                <span className="flex shrink-0 opacity-60 group-focus-within:opacity-100 group-hover:opacity-100">
                  <button
                    type="button"
                    className={iconButton}
                    aria-label={thread.pinned ? t('threads_action_unpin') : t('threads_action_pin')}
                    title={thread.pinned ? t('threads_action_unpin') : t('threads_action_pin')}
                    onClick={() => threadStore.setPinned(thread.id, !thread.pinned)}>
                    {thread.pinned ? <BsPinFill size={14} /> : <BsPin size={14} />}
                  </button>
                  <button
                    type="button"
                    className={iconButton}
                    aria-label={t('threads_action_rename')}
                    title={t('threads_action_rename')}
                    onClick={() => setRenaming({ id: thread.id, title: thread.title })}>
                    <FiEdit2 size={14} />
                  </button>
                  <button
                    type="button"
                    className={iconButton}
                    aria-label={thread.archived ? t('threads_action_unarchive') : t('threads_action_archive')}
                    title={thread.archived ? t('threads_action_unarchive') : t('threads_action_archive')}
                    onClick={() => threadStore.setArchived(thread.id, !thread.archived)}>
                    <FiArchive size={14} />
                  </button>
                  <button
                    type="button"
                    className={iconButton}
                    aria-label={t('threads_action_delete')}
                    title={t('threads_action_delete')}
                    onClick={() => setConfirmDelete(thread.id)}>
                    <FiTrash2 size={14} />
                  </button>
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => setShowArchived(!showArchived)}
        className={`mt-2 text-left text-sm underline ${muted}`}>
        {showArchived ? t('threads_showLive') : t('threads_showArchived')}
      </button>
    </div>
  );
}
