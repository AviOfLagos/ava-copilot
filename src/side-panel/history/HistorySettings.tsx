import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderPlus } from 'lucide-react';
import { t } from '@extension/i18n';
import { db, historyStore } from '@extension/storage';
import type { HistoryImport, KnowledgeItem } from '@extension/storage';
import { aiToolName } from '@src/background/history/tools';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { useLive } from '../hooks/useLive';
import { useWorkspaces } from '../workspaces/WorkspacePicker';
import { addFolder, allowFolder, folderAccess, forgetImport, historyRequest, runImport } from './reader';
import type { ImportProgress } from './reader';

const row = 'flex items-center gap-3 px-3 py-2.5';
const hint = 'text-muted-foreground mt-0.5 text-[11.5px]';
// Projects listed before "Show all"
const PROJECTS_SHOWN = 8;

/** The imports and project mappings, kept current as the background changes them. */
function useHistoryState() {
  const [state, setState] = useState<{ imports: HistoryImport[]; projects: Record<string, string | null> }>({
    imports: [],
    projects: {},
  });
  useEffect(() => {
    const load = () => void historyStore.get().then(value => setState(value));
    load();
    return historyStore.subscribe(load);
  }, []);
  return state;
}

function when(at: number | null): string {
  return at ? new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : t('history_never');
}

function progressText(progress: ImportProgress): string {
  if (progress.phase === 'scanning') return t('history_progress_scanning');
  return t('history_progress_reading', [
    String(progress.filesDone),
    String(progress.filesTotal),
    String(progress.conversations),
  ]);
}

function resultText(progress: ImportProgress): string {
  const parts = [
    t(progress.phase === 'cancelled' ? 'history_result_cancelled' : 'history_result_done', [
      String(progress.added),
      String(progress.updated),
    ]),
  ];
  if (progress.redacted) parts.push(t('history_result_redacted', [String(progress.redacted)]));
  if (progress.capped) parts.push(t('history_result_capped'));
  return parts.join(' ');
}

/**
 * Settings › Bring in your AI history: pick the folders other AI tools keep their sessions in (or a
 * ChatGPT / Claude.ai export), see what came in per workspace, map project folders to workspaces,
 * update, re-import or forget an import.
 */
export default function HistorySettings() {
  const { imports, projects: mappings } = useHistoryState();
  const workspaces = useWorkspaces();
  const sessions = useLive(
    () => db.kbItems.where('sourceType').equals('ai-session').toArray() as Promise<KnowledgeItem[]>,
    [],
    [] as KnowledgeItem[],
  );
  const [access, setAccess] = useState<Record<string, PermissionState | null>>({});
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Forget asks once more, in place
  const [confirming, setConfirming] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void Promise.all(imports.map(async item => [item.id, await folderAccess(item.id)] as const)).then(pairs =>
      setAccess(Object.fromEntries(pairs)),
    );
  }, [imports]);

  const names = useMemo(() => new Map(workspaces.map(workspace => [workspace.id, workspace.name])), [workspaces]);

  const byWorkspace = useMemo(() => {
    const counts = new Map<string | null, number>();
    for (const item of sessions) counts.set(item.workspaceId ?? null, (counts.get(item.workspaceId ?? null) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [sessions]);

  const projects = useMemo(() => {
    const groups = new Map<string, { count: number; workspaces: Map<string | null, number> }>();
    for (const item of sessions) {
      const project = item.origin?.project;
      if (!project) continue;
      const group = groups.get(project) ?? { count: 0, workspaces: new Map() };
      group.count++;
      group.workspaces.set(item.workspaceId ?? null, (group.workspaces.get(item.workspaceId ?? null) ?? 0) + 1);
      groups.set(project, group);
    }
    return [...groups.entries()]
      .map(([project, group]) => ({
        project,
        count: group.count,
        // Where most of its sessions are now
        workspaceId: [...group.workspaces.entries()].sort((a, b) => b[1] - a[1])[0][0],
      }))
      .sort((a, b) => b.count - a.count);
  }, [sessions]);

  const countFor = (importId: string) => sessions.filter(item => item.origin?.importId === importId).length;

  const run = async (importId: string, full: boolean) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(importId);
    setNotice(null);
    try {
      const done = await runImport(importId, { full, signal: controller.signal, onProgress: setProgress });
      setNotice({ text: resultText(done), error: false });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setRunning(null);
      setProgress(null);
      abortRef.current = null;
    }
  };

  const add = async () => {
    try {
      const importId = await addFolder();
      await run(importId, false);
    } catch (error) {
      // Closing the folder picker is not an error worth showing
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
      }
    }
  };

  const allow = async (importId: string) => {
    if (await allowFolder(importId)) await run(importId, false);
    setAccess({ ...access, [importId]: await folderAccess(importId) });
  };

  const forget = async (item: HistoryImport) => {
    if (confirming !== item.id) return setConfirming(item.id);
    setConfirming(null);
    const removed = await forgetImport(item.id);
    setNotice({ text: t('history_forgotten', [String(removed)]), error: false });
  };

  const mapProject = async (project: string, workspaceId: string | null) => {
    try {
      await historyRequest({ type: 'history_map_project', project, workspaceId });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
    }
  };

  const shown = showAll ? projects : projects.slice(0, PROJECTS_SHOWN);

  return (
    <>
      <div className={row}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px]">
            {t('history_title')}
            <Badge variant="outline">{t('history_sneakPeek')}</Badge>
          </div>
          <div className={hint}>{t('history_hint')}</div>
        </div>
        <Button size="sm" disabled={running !== null} onClick={() => void add()}>
          <FolderPlus className="size-3.5" />
          {t('history_add')}
        </Button>
      </div>

      <div className="px-3 py-2.5">
        <div className="label-mono mb-1">{t('history_where_title')}</div>
        <ul className="text-muted-foreground flex flex-col gap-0.5 text-[11.5px]">
          <li>{t('history_where_claude')}</li>
          <li>{t('history_where_codex')}</li>
          <li>{t('history_where_gemini')}</li>
          <li>{t('history_where_vscode')}</li>
          <li>{t('history_where_exports')}</li>
        </ul>
        <div className={hint}>{t('history_where_hidden')}</div>
      </div>

      {progress && (
        <div className={row} role="status" aria-live="polite">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px]">{progressText(progress)}</div>
            <div
              className="bg-muted mt-1.5 h-1 overflow-hidden rounded-full"
              role="progressbar"
              aria-label={t('history_progress_label')}
              aria-valuemin={0}
              aria-valuemax={progress.filesTotal || 1}
              aria-valuenow={progress.filesDone}>
              <div
                className="bg-primary h-full transition-[width]"
                style={{ width: `${progress.filesTotal ? (100 * progress.filesDone) / progress.filesTotal : 5}%` }}
              />
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => abortRef.current?.abort()}>
            {t('history_cancel')}
          </Button>
        </div>
      )}

      {notice && (
        <p
          role={notice.error ? 'alert' : 'status'}
          className={`px-3 py-2 text-[12px] ${notice.error ? 'text-destructive' : ''}`}>
          {notice.text}
        </p>
      )}

      {imports.map(item => (
        <div
          key={item.id}
          className="flex flex-col gap-2 px-3 py-2.5"
          aria-label={t('history_import_label', [item.label])}
          role="group">
          <div className="min-w-0">
            <div className="truncate text-[13px]">{item.label}</div>
            <div className={hint}>
              {[
                item.tools.map(aiToolName).join(', ') || t('history_tools_none'),
                t('history_import_count', [String(countFor(item.id))]),
                t('history_last', [when(item.lastImportAt)]),
              ].join(' · ')}
            </div>
          </div>
          {/* The buttons on a line of their own: three of them do not fit beside the name at 400 px */}
          <div className="flex flex-wrap items-center gap-1.5">
            {access[item.id] === 'granted' ? (
              <>
                <Button size="sm" variant="glass" disabled={running !== null} onClick={() => void run(item.id, false)}>
                  {t('history_update')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={running !== null}
                  onClick={() => void run(item.id, true)}
                  aria-label={t('history_reimport_label', [item.label])}>
                  {t('history_reimport')}
                </Button>
              </>
            ) : (
              <Button size="sm" disabled={running !== null} onClick={() => void allow(item.id)}>
                {t('history_allow')}
              </Button>
            )}
            <Button
              size="sm"
              variant={confirming === item.id ? 'destructive' : 'ghost'}
              disabled={running !== null}
              onClick={() => void forget(item)}
              aria-label={
                confirming === item.id
                  ? t('history_forget_confirm', [String(countFor(item.id))])
                  : t('history_forget_label', [item.label])
              }>
              {confirming === item.id ? t('history_forget_confirm', [String(countFor(item.id))]) : t('history_forget')}
            </Button>
          </div>
        </div>
      ))}

      {byWorkspace.length > 0 && (
        <div className="px-3 py-2.5">
          <div className="label-mono mb-1.5">{t('history_byWorkspace')}</div>
          <ul className="flex flex-wrap gap-1.5" aria-label={t('history_byWorkspace')}>
            {byWorkspace.map(([workspaceId, count]) => (
              <li key={workspaceId ?? '-'}>
                <Badge variant={workspaceId ? 'default' : 'secondary'}>
                  {(workspaceId && names.get(workspaceId)) || t('history_general')} · {count}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      {projects.length > 0 && (
        <div className="px-3 py-2.5">
          <div className="label-mono mb-0.5">{t('history_projects')}</div>
          <div className={`${hint} mb-1.5`}>{t('history_projects_hint')}</div>
          <ul className="flex flex-col gap-1">
            {shown.map(({ project, count, workspaceId }) => (
              <li key={project} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={project}>
                  {project.split('/').slice(-2).join('/')}
                  <span className="text-muted-foreground"> · {count}</span>
                </span>
                <select
                  aria-label={t('history_project_map', [project])}
                  value={(project in mappings ? mappings[project] : workspaceId) ?? ''}
                  onChange={event => void mapProject(project, event.target.value || null)}
                  className="bg-card h-6 max-w-[45%] rounded-full border px-2 text-[11px]">
                  <option value="">{t('history_general')}</option>
                  {workspaces.map(workspace => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
          {projects.length > PROJECTS_SHOWN && (
            <Button size="sm" variant="ghost" className="mt-1" onClick={() => setShowAll(!showAll)}>
              {showAll ? t('history_projects_fewer') : t('history_projects_all', [String(projects.length)])}
            </Button>
          )}
        </div>
      )}
    </>
  );
}
