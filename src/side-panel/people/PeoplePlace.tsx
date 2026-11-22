import { useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { t } from '@extension/i18n';
import { db, workspaceStore } from '@extension/storage';
import type { NameCandidate, Person, Workspace } from '@extension/storage';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { useLive } from '../hooks/useLive';
import { relativeTime } from '../inbox/meta';
import type { PanelApi } from '../registry';
import { PersonStatus, PersonStatusSummary } from '../followups/PersonStatus';
import { WhosWhoList } from './WhosWho';

/**
 * The People page (docs/pm-desk.md 5.5): everyone Ava knows, with every name they go by and where, and a "To
 * sort" tab with the names still waiting for an answer. The page only reads the tables; every change is a
 * `people_*` command the background carries out.
 */

const ALL = 'all';
const OPEN = new Set<NameCandidate['status']>(['watching', 'ask', 'asked']);

function useWorkspaces(): Workspace[] {
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

const inWorkspace = (workspaceIds: string[], workspace: string) =>
  workspace === ALL || workspaceIds.length === 0 || workspaceIds.includes(workspace);

const inputClass = 'bg-secondary text-secondary-foreground min-w-0 flex-1 rounded-lg px-2 py-1 text-[12.5px]';

function PersonRow({
  person,
  people,
  workspaces,
  api,
  onError,
}: {
  person: Person;
  people: Person[];
  workspaces: Workspace[];
  api: PanelApi;
  onError: (message: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(person.name);
  const [about, setAbout] = useState(person.about ?? '');
  const [alias, setAlias] = useState('');
  const [aliasWorkspace, setAliasWorkspace] = useState<string>(person.workspaceIds[0] ?? '');
  const [mergeWith, setMergeWith] = useState('');
  const [removing, setRemoving] = useState(false);
  const workspaceName = (id: string | null) =>
    id === null ? t('people_everywhere') : (workspaces.find(workspace => workspace.id === id)?.name ?? id);
  const lastSeen = Math.max(0, ...person.seen.map(sighting => sighting.at));

  const run = async (message: Record<string, unknown>) => {
    onError(null);
    try {
      await api.request(message);
      return true;
    } catch (problem) {
      onError(problem instanceof Error ? problem.message : String(problem));
      return false;
    }
  };

  return (
    <li className="glass rounded-xl px-3 py-2" data-testid="person-row" data-person={person.name}>
      <button
        type="button"
        className="flex w-full items-start justify-between gap-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}>
        <span className="min-w-0">
          <span className="block text-[13px] font-medium">{person.name}</span>
          {person.about && <span className="text-muted-foreground block text-[11.5px]">{person.about}</span>}
          {!open && <PersonStatusSummary personId={person.id} />}
        </span>
        {lastSeen > 0 && (
          <span className="text-muted-foreground shrink-0 text-[11px]">
            {t('people_lastSeen', [relativeTime(lastSeen)])}
          </span>
        )}
      </button>
      {(person.aliases.length > 0 || person.emails.length > 0 || person.handles.length > 0) && (
        <ul className="mt-1.5 flex flex-wrap gap-1" aria-label={t('people_names_a11y', [person.name])}>
          {person.aliases.map(item => (
            <li key={`${item.workspaceId}|${item.text}`} data-testid="person-alias">
              <Badge variant="outline" className="gap-1">
                {item.text}
                <span className="text-muted-foreground">· {workspaceName(item.workspaceId)}</span>
                {open && (
                  <button
                    type="button"
                    aria-label={t('people_alias_remove_a11y', [item.text])}
                    onClick={() =>
                      void run({
                        type: 'people_edit',
                        personId: person.id,
                        aliases: person.aliases.filter(other => other !== item),
                      })
                    }>
                    <X className="size-3" aria-hidden />
                  </button>
                )}
              </Badge>
            </li>
          ))}
          {person.emails.map(email => (
            <li key={email}>
              <Badge variant="outline">{email}</Badge>
            </li>
          ))}
          {person.handles.map(handle => (
            <li key={`${handle.kind}:${handle.value}`}>
              {/* A Slack handle is a conversation id, meaningless to read: only where they are */}
              <Badge variant="outline">{handle.kind === 'slack' ? 'Slack' : `${handle.kind} ${handle.value}`}</Badge>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          <PersonStatus personId={person.id} name={person.name} />
          <form
            className="flex flex-col gap-1.5"
            onSubmit={event => {
              event.preventDefault();
              void run({ type: 'people_edit', personId: person.id, name: name.trim(), about: about.trim() });
            }}>
            <input
              aria-label={t('people_name_label')}
              value={name}
              maxLength={120}
              onChange={e => setName(e.target.value)}
              className={inputClass}
            />
            <input
              aria-label={t('people_about_label')}
              placeholder={t('people_about_label')}
              value={about}
              maxLength={200}
              onChange={e => setAbout(e.target.value)}
              className={inputClass}
            />
            <Button size="sm" type="submit" className="self-start" disabled={!name.trim()}>
              {t('people_save')}
            </Button>
          </form>
          <form
            className="flex flex-wrap items-center gap-1.5"
            onSubmit={event => {
              event.preventDefault();
              if (!alias.trim()) return;
              void run({
                type: 'people_add_alias',
                personId: person.id,
                text: alias.trim(),
                workspaceId: aliasWorkspace || null,
              }).then(ok => ok && setAlias(''));
            }}>
            <input
              aria-label={t('people_alias_placeholder')}
              placeholder={t('people_alias_placeholder')}
              value={alias}
              maxLength={120}
              onChange={e => setAlias(e.target.value)}
              className={inputClass}
            />
            <select
              aria-label={t('people_alias_workspace')}
              value={aliasWorkspace}
              onChange={e => setAliasWorkspace(e.target.value)}
              className="bg-secondary text-secondary-foreground rounded-lg px-2 py-1 text-[12.5px]">
              {workspaces.map(workspace => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
              <option value="">{t('people_everywhere')}</option>
            </select>
            <Button size="sm" type="submit" variant="outline" disabled={!alias.trim()}>
              {t('people_alias_add')}
            </Button>
          </form>
          {people.length > 1 && (
            <form
              className="flex flex-wrap items-center gap-1.5"
              onSubmit={event => {
                event.preventDefault();
                if (mergeWith) void run({ type: 'people_merge', keepId: mergeWith, dropId: person.id });
              }}>
              <select
                aria-label={t('people_merge_label')}
                value={mergeWith}
                onChange={e => setMergeWith(e.target.value)}
                className={inputClass}>
                <option value="">{t('people_merge_label')}</option>
                {people
                  .filter(other => other.id !== person.id)
                  .map(other => (
                    <option key={other.id} value={other.id}>
                      {other.name}
                    </option>
                  ))}
              </select>
              <Button size="sm" type="submit" variant="outline" disabled={!mergeWith}>
                {t('people_merge_action')}
              </Button>
            </form>
          )}
          <Button
            size="sm"
            variant={removing ? 'destructive' : 'ghost'}
            className="self-start"
            onClick={() => (removing ? void run({ type: 'people_remove', personId: person.id }) : setRemoving(true))}>
            {removing ? t('people_remove_confirm') : t('people_remove')}
          </Button>
        </div>
      )}
    </li>
  );
}

export default function PeoplePlace({ api }: { api: PanelApi }) {
  const people = useLive(() => db.people.toArray(), [], [] as Person[]);
  const names = useLive(
    () => db.peopleNames.where('status').anyOf(['ask', 'asked', 'watching']).toArray(),
    [],
    [] as NameCandidate[],
  );
  const workspaces = useWorkspaces();
  const [tab, setTab] = useState<'people' | 'sort'>('people');
  const [workspace, setWorkspace] = useState(ALL);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const shown = useMemo(
    () =>
      people.filter(person => inWorkspace(person.workspaceIds, workspace)).sort((a, b) => a.name.localeCompare(b.name)),
    [people, workspace],
  );
  // To sort: the names waiting for an answer first, then the ones seen once, most-seen first
  const toSort = useMemo(
    () =>
      names
        .filter(candidate => OPEN.has(candidate.status))
        .filter(candidate => workspace === ALL || candidate.workspaceId === null || candidate.workspaceId === workspace)
        .sort((a, b) => Number(a.status === 'watching') - Number(b.status === 'watching') || b.count - a.count),
    [names, workspace],
  );

  const add = async () => {
    setError(null);
    try {
      await api.request({
        type: 'people_create',
        name: newName.trim(),
        workspaceId: workspace === ALL ? null : workspace,
      });
      setNewName('');
      setAdding(false);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  };

  const tabClass = (active: boolean) =>
    active
      ? 'bg-primary/15 border-primary/50 text-foreground rounded-full border px-2.5 py-1 text-[11.5px] font-medium'
      : 'glass text-muted-foreground rounded-full px-2.5 py-1 text-[11.5px]';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <header className="px-1">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em]">{t('people_title')}</h1>
          <Button size="sm" variant="glass" onClick={() => setAdding(value => !value)}>
            <Plus className="size-3.5" aria-hidden />
            {t('people_add')}
          </Button>
        </div>
        <p className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">{t('people_intro')}</p>
      </header>

      {error && (
        <div role="alert" className="border-destructive/40 bg-destructive/10 rounded-xl border px-3 py-2 text-[12.5px]">
          {error}
        </div>
      )}

      {adding && (
        <form
          className="flex items-center gap-1.5"
          onSubmit={event => {
            event.preventDefault();
            if (newName.trim()) void add();
          }}>
          <input
            aria-label={t('people_add_placeholder')}
            placeholder={t('people_add_placeholder')}
            value={newName}
            maxLength={120}
            onChange={e => setNewName(e.target.value)}
            className={inputClass}
          />
          <Button size="sm" type="submit" disabled={!newName.trim()}>
            {t('people_save')}
          </Button>
        </form>
      )}

      <div className="flex flex-wrap items-center gap-1.5" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'people'}
          className={tabClass(tab === 'people')}
          onClick={() => setTab('people')}>
          {t('people_tab_people')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'sort'}
          className={tabClass(tab === 'sort')}
          onClick={() => setTab('sort')}>
          {t('people_tab_sort', [String(toSort.length)])}
        </button>
        {workspaces.length > 1 && (
          <select
            aria-label={t('people_workspace_all')}
            value={workspace}
            onChange={e => setWorkspace(e.target.value)}
            className="bg-secondary text-secondary-foreground rounded-full px-2.5 py-1 text-[11.5px]">
            <option value={ALL}>{t('people_workspace_all')}</option>
            {workspaces.map(item => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {tab === 'people' ? (
        shown.length === 0 ? (
          <div className="glass rounded-2xl px-4 py-5">
            <p className="text-muted-foreground text-[12.5px] leading-relaxed">{t('people_empty')}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {shown.map(person => (
              <PersonRow
                key={person.id}
                person={person}
                people={people}
                workspaces={workspaces}
                api={api}
                onError={setError}
              />
            ))}
          </ul>
        )
      ) : toSort.length === 0 ? (
        <div className="glass rounded-2xl px-4 py-5">
          <p className="text-muted-foreground text-[12.5px] leading-relaxed">{t('people_sort_empty')}</p>
        </div>
      ) : (
        <div className="glass rounded-xl px-3 py-2">
          <WhosWhoList candidates={toSort} people={people} api={api} />
        </div>
      )}
    </div>
  );
}
