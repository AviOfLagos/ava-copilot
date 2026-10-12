import { useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  CalendarDays,
  ChevronUp,
  CircleHelp,
  Disc,
  ExternalLink,
  House,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Search,
  SlidersHorizontal,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { t } from '@extension/i18n';
import { threadStore } from '@extension/storage';
import type { ThreadRecord } from '@extension/storage';
import { cn } from '@extension/ui';
import { useLive } from '../hooks/useLive';
import { StatusDot } from '../threads/ThreadList';
import { groupByDate } from '../threads/history';
import { registeredPlaces } from '../registry';
import type { RegisteredPlaceId } from '../registry';
import type { HistoryGroup } from '../threads/history';
import { RowMenu, RowMenuContent, RowMenuItem, RowMenuTrigger } from '../components/ui/row-menu';
import { Badge } from '../components/ui/badge';
import { initialsOf, useDisplayName } from '../account/useProfile';

export type Place = 'chat' | 'today' | 'meetings' | 'memory' | 'settings' | 'help' | RegisteredPlaceId;

type Key = Parameters<typeof t>[0];

interface SidebarProps {
  open: boolean;
  place: Place;
  // A chat is open: it, not Home, is where the user is
  inChat: boolean;
  activeThreadId: string | null;
  onClose: () => void;
  onGo: (place: Place) => void;
  onNewChat: () => void;
  onSelect: (threadId: string) => void;
  onDelete: (threadId: string) => void;
  onPopOut: () => void;
}

// The drawer's top list: the everyday places, plus whatever a stream registered for 'top', merged
// and sorted by `order`. Gaps (10, 40, 50) are left for places not built yet (a registered place
// that does not exist yet is simply absent, so the list degrades gracefully wave over wave).
const CORE_TOP: { place: Place; label: Key; icon: LucideIcon; order: number }[] = [
  { place: 'chat', label: 'nav_home', icon: House, order: 0 },
  { place: 'today', label: 'today_title', icon: CalendarDays, order: 20 },
  { place: 'meetings', label: 'nav_meetings', icon: Disc, order: 30 },
];

// The profile popover: account-ish places. Knowledge base and Settings used to live in the top
// list; they live here now, alongside Workspaces/Skills (registered by this stream) and whatever
// Connectors/Models & usage/other streams add.
const CORE_PROFILE: { place: Place; label: Key; icon: LucideIcon; order: number }[] = [
  { place: 'memory', label: 'kb_title', icon: BookOpen, order: 0 },
  { place: 'settings', label: 'settings_title', icon: SlidersHorizontal, order: 50 },
  { place: 'help', label: 'nav_help', icon: CircleHelp, order: 60 },
];

function groupLabel(group: HistoryGroup): string {
  switch (group.key) {
    case 'pinned':
      return t('history_pinned');
    case 'today':
      return t('history_today');
    case 'yesterday':
      return t('history_yesterday');
    case 'week':
      return t('history_week');
    case 'month':
      return t('history_month');
    default:
      return group.label ?? '';
  }
}

/** One chat in the history: open it, or from its menu rename, pin, archive or delete it. */
function HistoryRow({
  thread,
  active,
  onSelect,
  onDelete,
}: {
  thread: ThreadRecord;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const title = thread.title || t('threads_untitled');

  const saveRename = async () => {
    if (renaming?.trim()) await threadStore.rename(thread.id, renaming);
    setRenaming(null);
  };

  if (renaming !== null) {
    return (
      <li className="px-1.5 py-0.5">
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={renaming}
          aria-label={t('threads_action_rename')}
          onChange={event => setRenaming(event.target.value)}
          onBlur={() => void saveRename()}
          onKeyDown={event => {
            if (event.key === 'Enter') void saveRename();
            if (event.key === 'Escape') setRenaming(null);
          }}
          className="glass w-full rounded-lg px-2 py-1.5 text-[13px] text-foreground outline-none focus:border-primary/50"
        />
      </li>
    );
  }

  if (confirming) {
    return (
      <li className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px]">
        <span className="text-destructive truncate">{t('threads_action_confirmDelete')}</span>
        <span className="flex shrink-0 gap-1">
          <button
            type="button"
            className="border-destructive/60 bg-destructive/25 rounded-full border px-2 py-0.5"
            onClick={onDelete}>
            {t('threads_action_delete')}
          </button>
          <button
            type="button"
            className="rounded-full px-2 py-0.5 hover:bg-accent"
            onClick={() => setConfirming(false)}>
            {t('threads_action_keep')}
          </button>
        </span>
      </li>
    );
  }

  const item = 'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px]';
  return (
    <li className="relative">
      <div
        className={cn(
          'group flex items-center gap-2 rounded-lg pl-2.5 pr-1',
          active ? 'bg-accent text-foreground' : 'hover:bg-accent/60',
        )}>
        <StatusDot thread={thread} />
        <button
          type="button"
          onClick={onSelect}
          aria-current={active ? 'page' : undefined}
          className="min-w-0 flex-1 truncate py-1.5 text-left text-[13px]">
          {title}
        </button>
        <RowMenu>
          <RowMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('history_menu', [title])}
              className="text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-md opacity-0 hover:text-foreground focus:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100">
              <MoreHorizontal className="size-4" />
            </button>
          </RowMenuTrigger>
          <RowMenuContent data-row-menu="history" align="end" sideOffset={4} className="w-40">
            <RowMenuItem asChild onSelect={() => setRenaming(thread.title)}>
              <button type="button" className={item}>
                <Pencil className="size-3.5" />
                {t('threads_action_rename')}
              </button>
            </RowMenuItem>
            <RowMenuItem asChild onSelect={() => void threadStore.setPinned(thread.id, !thread.pinned)}>
              <button type="button" className={item}>
                {thread.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                {thread.pinned ? t('threads_action_unpin') : t('threads_action_pin')}
              </button>
            </RowMenuItem>
            <RowMenuItem asChild onSelect={() => void threadStore.setArchived(thread.id, !thread.archived)}>
              <button type="button" className={item}>
                {thread.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
                {thread.archived ? t('threads_action_unarchive') : t('threads_action_archive')}
              </button>
            </RowMenuItem>
            <RowMenuItem asChild destructive onSelect={() => setConfirming(true)}>
              <button type="button" className={item}>
                <Trash2 className="size-3.5" />
                {t('threads_action_delete')}
              </button>
            </RowMenuItem>
          </RowMenuContent>
        </RowMenu>
      </div>
    </li>
  );
}

/**
 * The drawer from the left, as in chat apps: a new chat, search, the everyday places, the chat
 * history grouped by date, and a profile button whose popover holds the account-ish places. It is
 * how you find your way, so every place has a label.
 */
export default function Sidebar(props: SidebarProps) {
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const threads = useLive(() => threadStore.list({ archived, search }), [archived, search], []);
  const groups = groupByDate(threads);
  const current = props.place === 'chat' && props.inChat ? null : props.place;
  const displayName = useDisplayName();

  const topPlaces = [
    ...CORE_TOP,
    ...registeredPlaces('top').map(({ id, label, icon, order }) => ({ place: id as Place, label, icon, order })),
  ].sort((a, b) => a.order - b.order);

  const profilePlaces = [
    ...CORE_PROFILE,
    ...registeredPlaces('profile').map(({ id, label, icon, order }) => ({ place: id as Place, label, icon, order })),
  ].sort((a, b) => a.order - b.order);

  useEffect(() => {
    if (!props.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // A floating menu (the profile popover, or a chat row's "⋯") handles its own Escape first;
      // a second press, with no menu left open, closes the drawer.
      if (document.querySelector('[role="menu"]')) return;
      props.onClose();
    };
    window.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [props.open, props.onClose]);

  if (!props.open) return null;

  return (
    <div className="absolute inset-0 z-40 flex">
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('nav_menu')}
        className="bg-background/95 animate-in slide-in-from-left-4 fade-in-0 border-border/60 flex h-full w-[86%] max-w-[320px] flex-col border-r shadow-2xl outline-none backdrop-blur-xl">
        <div className="flex items-center gap-1 px-2.5 pb-1 pt-2.5">
          <button
            type="button"
            onClick={props.onNewChat}
            className="hover:bg-accent flex flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-[13.5px] font-medium">
            <SquarePen className="size-4" />
            {t('nav_newChat')}
          </button>
          <button
            type="button"
            onClick={props.onClose}
            aria-label={t('nav_close')}
            className="text-muted-foreground hover:bg-accent flex size-8 items-center justify-center rounded-lg hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        <label className="glass mx-2.5 mt-1 flex items-center gap-2 rounded-xl px-2.5 py-1.5">
          <Search className="text-muted-foreground size-3.5 shrink-0" />
          <input
            type="search"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder={t('history_search')}
            aria-label={t('history_search')}
            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none"
          />
        </label>

        <nav aria-label={t('nav_places')} className="mt-2 px-1.5">
          {topPlaces.map(({ place, label, icon: Icon }) => (
            <button
              key={place}
              type="button"
              onClick={() => props.onGo(place)}
              aria-current={current === place ? 'page' : undefined}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px]',
                current === place
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}>
              <Icon className="size-4" />
              {t(label)}
            </button>
          ))}
        </nav>

        <div className="border-border/60 mx-3 my-2 border-t" />

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" aria-label={t('history_title')} role="region">
          {groups.length === 0 && (
            <p className="text-muted-foreground px-2.5 py-2 text-[12.5px]">
              {search ? t('history_noMatch') : t('threads_empty')}
            </p>
          )}
          {groups.map(group => (
            <section key={group.key} className="mb-2">
              <h3 className="text-muted-foreground px-2.5 pb-0.5 pt-1.5 text-[11px] font-medium">
                {groupLabel(group)}
              </h3>
              <ul>
                {group.threads.map(thread => (
                  <HistoryRow
                    key={thread.id}
                    thread={thread}
                    active={thread.id === props.activeThreadId && props.place === 'chat'}
                    onSelect={() => props.onSelect(thread.id)}
                    onDelete={() => props.onDelete(thread.id)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="border-border/60 border-t">
          <RowMenu>
            <RowMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('shell_profile_open')}
                className="hover:bg-accent flex w-full items-center gap-2.5 px-2.5 py-2 text-left">
                <span className="bg-primary/20 text-primary flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold">
                  {initialsOf(displayName)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {displayName || t('shell_profile_defaultName')}
                </span>
                <Badge variant="outline" className="shrink-0">
                  {t('shell_profile_localChip')}
                </Badge>
                <ChevronUp className="text-muted-foreground size-3.5 shrink-0" />
              </button>
            </RowMenuTrigger>
            <RowMenuContent data-row-menu="profile" side="top" align="start" sideOffset={8} className="w-[232px]">
              {profilePlaces.map(({ place, label, icon: Icon }) => (
                <RowMenuItem key={place} asChild onSelect={() => props.onGo(place)}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-[13px]">
                    <Icon className="size-4" />
                    {t(label)}
                  </button>
                </RowMenuItem>
              ))}
            </RowMenuContent>
          </RowMenu>
          <div className="flex items-center justify-between px-2.5 py-1.5">
            <button
              type="button"
              onClick={() => setArchived(!archived)}
              className="text-muted-foreground hover:bg-accent whitespace-nowrap rounded-lg px-2 py-1 text-[12px] hover:text-foreground">
              {archived ? t('history_live') : t('history_archived')}
            </button>
            <button
              type="button"
              onClick={props.onPopOut}
              aria-label={t('threads_popOut')}
              className="text-muted-foreground hover:bg-accent flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1 text-[12px] hover:text-foreground">
              <ExternalLink className="size-3.5" />
              {t('nav_popOut')}
            </button>
          </div>
        </div>
      </div>
      <button
        type="button"
        aria-label={t('nav_close')}
        tabIndex={-1}
        onClick={props.onClose}
        className="flex-1 bg-black/40 backdrop-blur-[1px]"
      />
    </div>
  );
}
