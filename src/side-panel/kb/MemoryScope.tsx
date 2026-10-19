import { useState } from 'react';
import { Lock, Trash2, Users } from 'lucide-react';
import { t } from '@extension/i18n';
import { db } from '@extension/storage';
import type { KnowledgeItem } from '@extension/storage';
import { itemScope } from '@src/background/kb/scope';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { useLive } from '../hooks/useLive';

// Private and team memory for agents, as small parts any page can use: the Knowledge base, an agent's
// page, and later the full-page Settings. They talk to the background with one-off messages
// (`memory_*`, src/background/kb/register.ts), so they need nothing from the page they sit in.

/** A one-off command to the background, answered with its reply or thrown as its error. */
export async function memoryRequest(message: Record<string, unknown>): Promise<unknown> {
  const reply = (await chrome.runtime.sendMessage({ ...message, requestId: crypto.randomUUID() })) as
    { type?: string; error?: string; result?: unknown } | undefined;
  if (!reply) throw new Error(t('kb_scope_noAnswer'));
  if (reply.type === 'error') throw new Error(reply.error || t('kb_scope_failed'));
  return reply.result;
}

/** "Private" for an agent's own memory, "Team" for what every agent reads; nothing for the user's own. */
export function ScopeBadge({ item, agentName }: { item: KnowledgeItem; agentName?: string }) {
  const scope = itemScope(item);
  if (scope === 'unowned') return null;
  const label = scope === 'team' ? t('kb_scope_team') : t('kb_scope_private');
  const title =
    scope === 'team' ? t('kb_scope_team_hint') : t('kb_scope_private_hint', [agentName || t('kb_scope_anAgent')]);
  return (
    <Badge variant={scope === 'team' ? 'default' : 'outline'} title={title} data-scope={scope}>
      {scope === 'team' ? <Users className="size-3" aria-hidden /> : <Lock className="size-3" aria-hidden />}
      {label}
    </Badge>
  );
}

/**
 * The user's moves for one item: an agent's private item to the team, an agent's team item back to private,
 * and (optionally) delete. The user's own items are every agent's already, so they only get delete.
 */
export function ScopeActions({ item, withDelete = true }: { item: KnowledgeItem; withDelete?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = itemScope(item);
  const run = async (message: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await memoryRequest(message);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {error && (
        <span role="alert" className="text-destructive max-w-24 truncate text-[11px]" title={error}>
          {error}
        </span>
      )}
      {scope === 'private' && item.agentId && (
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={busy}
          onClick={() => void run({ type: 'memory_set_scope', itemId: item.id, scope: 'team' })}
          aria-label={t('kb_scope_toTeam', [item.title])}
          title={t('kb_scope_toTeam', [item.title])}>
          <Users className="size-3.5" aria-hidden />
        </Button>
      )}
      {scope === 'team' && item.agentId && (
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={busy}
          onClick={() => void run({ type: 'memory_set_scope', itemId: item.id, scope: 'private' })}
          aria-label={t('kb_scope_toPrivate', [item.title])}
          title={t('kb_scope_toPrivate', [item.title])}>
          <Lock className="size-3.5" aria-hidden />
        </Button>
      )}
      {withDelete && (
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={busy}
          onClick={() => void run({ type: 'memory_delete', itemId: item.id })}
          aria-label={t('kb_delete', [item.title])}
          title={t('kb_delete', [item.title])}>
          <Trash2 className="size-3.5" aria-hidden />
        </Button>
      )}
    </span>
  );
}

function relative(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function MemoryList({ id, title, items, empty }: { id: string; title: string; items: KnowledgeItem[]; empty: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 5);
  return (
    <div className="flex flex-col gap-0.5" aria-labelledby={id} role="group">
      <h3 id={id} className="text-muted-foreground px-1 text-[11.5px]">
        {title} · {items.length}
      </h3>
      {items.length === 0 ? (
        <p className="text-muted-foreground px-1 text-[12px]">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {shown.map(item => (
            <li key={item.id} className="flex items-center gap-1 px-1 text-[12px]" data-memory-item={item.id}>
              <span className="min-w-0 flex-1 truncate">
                {item.title}
                <span className="text-muted-foreground"> · {relative(item.sourceDate)}</span>
              </span>
              <ScopeActions item={item} />
            </li>
          ))}
          {items.length > shown.length && (
            <li>
              <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
                {t('kb_scope_showAll', [String(items.length)])}
              </Button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * One agent's memory: what only it (and Ava, and the user) reads, and the team memory every agent reads,
 * each with move-to-team / make-private / delete.
 */
export function AgentMemory({ agentId }: { agentId: string }) {
  const items = useLive(() => db.kbItems.toArray() as Promise<KnowledgeItem[]>, [], [] as KnowledgeItem[]);
  const newest = (list: KnowledgeItem[]) => [...list].sort((a, b) => b.sourceDate - a.sourceDate);
  const own = newest(items.filter(item => item.agentId === agentId && itemScope(item) === 'private'));
  const team = newest(items.filter(item => itemScope(item) === 'team'));
  return (
    <div className="flex flex-col gap-2">
      <MemoryList
        id={`memory-private-${agentId}`}
        title={t('kb_scope_privateList')}
        items={own}
        empty={t('kb_scope_privateNone')}
      />
      <MemoryList
        id={`memory-team-${agentId}`}
        title={t('kb_scope_teamList')}
        items={team}
        empty={t('kb_scope_teamNone')}
      />
    </div>
  );
}
