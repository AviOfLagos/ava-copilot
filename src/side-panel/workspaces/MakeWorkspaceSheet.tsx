import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Undo2 } from 'lucide-react';
import { t } from '@extension/i18n';
import type { PlaceKind, WorkspaceOffer } from '@extension/storage';
import { Button } from '../components/ui/button';
import { workspacesRequest } from './client';

// The sheet of docs/pm-desk.md, Part 3: "Make a workspace for these". A name and keywords to start from (a light model
// suggests them, Avi edits), and a tick list of what moves, all ticked. Saving makes the workspace and moves the ticked
// things; one Undo takes both back. The same sheet confirms a workspace made by voice: then the workspace exists and
// the list is what looks like it (`offer`).

type MessageKey = Parameters<typeof t>[0];

interface Row {
  kind: PlaceKind;
  id: string;
  title: string;
}

interface Made {
  moveId: string;
  workspaceName: string;
  moved: number;
  skipped: number;
}

const KIND_LABEL: Record<PlaceKind, MessageKey> = {
  task: 'workspaces_kind_task',
  thread: 'workspaces_kind_thread',
  meeting: 'workspaces_kind_meeting',
  kb: 'workspaces_kind_kb',
};

const inputClass =
  'bg-card text-foreground placeholder:text-muted-foreground border-border focus:border-primary/50 h-8 min-w-0 rounded-lg border px-2.5 text-[13px] outline-none';

const keyOf = (row: Pick<Row, 'kind' | 'id'>) => `${row.kind}:${row.id}`;

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One Undo, for a move, with the thirty seconds of the toast counted down and then the Inbox named. */
export function UndoToast({ moveId, text, startedAt }: { moveId: string; text: string; startedAt: number }) {
  const [left, setLeft] = useState(() => Math.max(0, 30 - Math.floor((Date.now() - startedAt) / 1000)));
  const [state, setState] = useState<'ready' | 'undone'>('ready');
  const [error, setError] = useState('');
  useEffect(() => {
    if (left <= 0 || state === 'undone') return;
    const timer = window.setTimeout(() => setLeft(value => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [left, state]);

  const undo = async () => {
    setError('');
    try {
      await workspacesRequest({ type: 'workspaces_undo', moveId });
      setState('undone');
    } catch (problem) {
      setError(failure(problem));
    }
  };

  return (
    <div className="glass flex flex-col gap-1.5 rounded-xl px-3 py-2.5 text-[12.5px]" role="status">
      <span>{state === 'undone' ? t('workspaces_undone') : text}</span>
      {state === 'ready' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="glass" onClick={() => void undo()}>
            <Undo2 className="size-3.5" aria-hidden />
            {t('workspaces_undo')}
          </Button>
          <span className="text-muted-foreground text-[11.5px]">
            {left > 0 ? t('workspaces_undo_seconds', [String(left)]) : t('workspaces_undo_inbox')}
          </span>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      )}
    </div>
  );
}

function TickList({ rows, ticked, onToggle }: { rows: Row[]; ticked: Set<string>; onToggle: (key: string) => void }) {
  return (
    <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto" aria-label={t('workspaces_sheet_moves')}>
      {rows.map(row => (
        <li key={keyOf(row)}>
          <label className="flex cursor-pointer items-start gap-2 text-[12.5px] leading-snug">
            <input
              type="checkbox"
              className="mt-0.5 shrink-0"
              checked={ticked.has(keyOf(row))}
              onChange={() => onToggle(keyOf(row))}
            />
            <span className="min-w-0 flex-1 break-words">{row.title || t('threads_untitled')}</span>
            <span className="text-muted-foreground shrink-0 text-[11px]">{t(KIND_LABEL[row.kind])}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

const useTicks = (rows: Row[]) => {
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const ticked = useMemo(() => new Set(rows.map(keyOf).filter(key => !unticked.has(key))), [rows, unticked]);
  const toggle = (key: string) =>
    setUnticked(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return { ticked, toggle };
};

/** "Make a workspace for these": a name, keywords, what moves, one confirm. */
export function MakeWorkspaceSheet({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [name, setName] = useState('');
  const [keywords, setKeywords] = useState('');
  const [suggesting, setSuggesting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState<Made | null>(null);
  const [madeAt, setMadeAt] = useState(0);
  const { ticked, toggle } = useTicks(rows ?? []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { items } = await workspacesRequest<{ items: Row[] }>({ type: 'workspaces_unplaced' });
        if (!alive) return;
        setRows(items);
        if (items.length === 0) return;
        const suggestion = await workspacesRequest<{ name: string; keywords: string[] }>({
          type: 'workspaces_suggest',
          refs: items.map(({ kind, id }) => ({ kind, id })),
        });
        if (!alive) return;
        // Only fills what Avi has not started typing
        setName(current => current || suggestion.name);
        setKeywords(current => current || suggestion.keywords.join(', '));
      } catch (problem) {
        if (alive) setError(failure(problem));
        if (alive) setRows(current => current ?? []);
      } finally {
        if (alive) setSuggesting(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await workspacesRequest<Made>({
        type: 'workspaces_make',
        name,
        keywords: keywords
          .split(',')
          .map(word => word.trim())
          .filter(Boolean),
        refs: (rows ?? []).filter(row => ticked.has(keyOf(row))).map(({ kind, id }) => ({ kind, id })),
      });
      setMade(result);
      setMadeAt(Date.now());
    } catch (problem) {
      setError(failure(problem));
    } finally {
      setBusy(false);
    }
  };

  if (made) {
    return (
      <div className="flex flex-col gap-2">
        <UndoToast
          moveId={made.moveId}
          startedAt={madeAt}
          text={[
            t('workspaces_done_made', [made.workspaceName, String(made.moved)]),
            made.skipped > 0 ? t('workspaces_done_skipped', [String(made.skipped)]) : '',
          ]
            .filter(Boolean)
            .join(' ')}
        />
        <Button size="sm" variant="ghost" className="self-start" onClick={onClose}>
          {t('workspaces_close')}
        </Button>
      </div>
    );
  }

  return (
    <form
      className="glass flex flex-col gap-2.5 rounded-xl p-3"
      aria-label={t('workspaces_sheet_title')}
      onSubmit={event => {
        event.preventDefault();
        if (name.trim() && !busy) void save();
      }}>
      <h3 className="text-[13px] font-semibold">{t('workspaces_sheet_title')}</h3>
      {suggesting && rows === null ? (
        <p className="text-muted-foreground flex items-center gap-1.5 text-[12.5px]" role="status">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {t('workspaces_sheet_loading')}
        </p>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-[12px]">
            {t('workspaces_sheet_name')}
            <input
              className={inputClass}
              value={name}
              maxLength={60}
              placeholder={suggesting ? t('workspaces_sheet_thinking') : ''}
              onChange={event => setName(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px]">
            {t('workspaces_sheet_keywords')}
            <input
              className={inputClass}
              value={keywords}
              placeholder={t('workspaces_sheet_keywordsExample')}
              onChange={event => setKeywords(event.target.value)}
            />
          </label>
          {rows && rows.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="label-mono">{t('workspaces_sheet_moves')}</span>
              <TickList rows={rows} ticked={ticked} onToggle={toggle} />
            </div>
          ) : (
            <p className="text-muted-foreground text-[12.5px]">{t('workspaces_sheet_empty')}</p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" type="submit" disabled={busy || rows === null || !name.trim()}>
          <Check className="size-3.5" aria-hidden />
          {t('workspaces_sheet_save', [String(ticked.size)])}
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={onClose}>
          {t('tasks_cancel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * An offer waiting for a yes (a workspace made by voice and what looks like it, a model's guess, things that may be in the
 * wrong workspace): the same sheet's tick list and one confirm. Nothing moved until the click.
 */
export function OfferSheet({ offer, onDone }: { offer: WorkspaceOffer; onDone?: () => void }) {
  const rows: Row[] = useMemo(
    () => offer.items.map(item => ({ kind: item.kind, id: item.id, title: item.title })),
    [offer.items],
  );
  const { ticked, toggle } = useTicks(rows);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState<{ moveId: string | null; moved: number; at: number } | null>(null);

  const answer = async (yes: boolean) => {
    setBusy(true);
    setError('');
    try {
      if (yes) {
        const result = await workspacesRequest<{ moveId: string | null; moved: number }>({
          type: 'workspaces_offer_accept',
          offerId: offer.id,
          refs: rows.filter(row => ticked.has(keyOf(row))).map(({ kind, id }) => ({ kind, id })),
        });
        setMade({ ...result, at: Date.now() });
      } else {
        await workspacesRequest({ type: 'workspaces_offer_dismiss', offerId: offer.id });
        onDone?.();
      }
    } catch (problem) {
      setError(failure(problem));
    } finally {
      setBusy(false);
    }
  };

  if (offer.status === 'moved' && !made) {
    return <p className="text-muted-foreground text-[12.5px]">{t('workspaces_offer_moved', [offer.workspaceName])}</p>;
  }
  if (offer.status === 'dismissed') {
    return <p className="text-muted-foreground text-[12.5px]">{t('workspaces_offer_dismissed')}</p>;
  }
  if (made) {
    return made.moveId ? (
      <UndoToast
        moveId={made.moveId}
        startedAt={made.at}
        text={t('workspaces_offer_answered', [String(made.moved), offer.workspaceName])}
      />
    ) : (
      <p className="text-muted-foreground text-[12.5px]">{t('workspaces_offer_nothing')}</p>
    );
  }

  return (
    <div className="glass flex flex-col gap-2 rounded-xl p-3" role="group" aria-label={offer.workspaceName}>
      <h3 className="text-[13px] font-semibold">
        {offer.kind === 'wrong'
          ? t('workspaces_offer_wrong', [String(rows.length), offer.workspaceName])
          : t('workspaces_offer_looksLike', [String(rows.length), offer.workspaceName])}
      </h3>
      <TickList rows={rows} ticked={ticked} onToggle={toggle} />
      {error && (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" disabled={busy || ticked.size === 0} onClick={() => void answer(true)}>
          <Check className="size-3.5" aria-hidden />
          {t('workspaces_offer_move', [String(ticked.size), offer.workspaceName])}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void answer(false)}>
          {t('workspaces_offer_notNow')}
        </Button>
      </div>
    </div>
  );
}
