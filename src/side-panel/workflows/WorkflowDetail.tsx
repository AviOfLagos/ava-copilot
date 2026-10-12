import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, Check, Maximize2, Pause, Pencil, Play, Square, Trash2 } from 'lucide-react';
import { t } from '@extension/i18n';
import { db } from '@extension/storage';
import type { JobRecord, RunRecord, RunStep, WorkflowRecord } from '@extension/storage';
import { cn } from '@extension/ui';
import { diffSpecs } from '@src/background/workflows/diff';
import { parseSpec } from '@src/background/workflows/spec';
import { Button } from '../components/ui/button';
import { HoldButton } from '../components/ui/hold-button';
import { useLive } from '../hooks/useLive';
import type { PanelApi } from '../registry';
import FlowDiagram from './FlowDiagram';
import { durationText, relativeTime, STATUS_LABEL, statusTone, whenText } from './meta';
import NodeInspector from './NodeInspector';
import { scheduleOf, StatusBadge } from './WorkflowsPlace';

const OPEN: ReadonlySet<string> = new Set(['queued', 'running', 'waiting_user']);

const TRIGGER_LABEL: Record<string, Parameters<typeof t>[0]> = {
  schedule: 'flow_by_schedule',
  manual: 'flow_by_hand',
  chat: 'flow_by_chat',
  voice: 'flow_by_voice',
  event: 'flow_by_event',
};

function RunRow({ run, shown, onShow }: { run: RunRecord; shown: boolean; onShow: () => void }) {
  const took = run.endedAt ? durationText(run.endedAt - run.startedAt) : null;
  return (
    <li>
      <button
        type="button"
        onClick={onShow}
        aria-pressed={shown}
        className={cn(
          'hover:bg-accent flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left',
          shown && 'bg-accent',
        )}>
        <span className={cn('mt-[6px] size-2 shrink-0 rounded-full', statusTone(run.status))} aria-hidden />
        <span className="min-w-0 flex-1 text-[12px]">
          <span className="font-medium">{t(STATUS_LABEL[run.status])}</span>
          <span className="text-muted-foreground">
            {' · '}
            {relativeTime(run.startedAt)}
            {' · '}
            {t(TRIGGER_LABEL[run.trigger.type] ?? 'flow_by_hand')}
            {took ? ` · ${took}` : ''}
            {run.inputTokens + run.outputTokens > 0
              ? ` · ${t('flow_tokens', [String(run.inputTokens + run.outputTokens)])}`
              : ''}
          </span>
          {run.error && run.status !== 'succeeded' && (
            <span className="text-muted-foreground block truncate">{run.error.message}</span>
          )}
        </span>
      </button>
    </li>
  );
}

export interface WorkflowDetailProps {
  id: string;
  api: PanelApi;
  onBack: () => void;
  wide?: boolean;
  onOpenFull?: () => void;
}

export default function WorkflowDetail({ id, api, onBack, wide = false, onOpenFull }: WorkflowDetailProps) {
  const workflow = useLive(() => db.workflows.get(id), [id], null as WorkflowRecord | undefined | null);
  const runs = useLive(
    () =>
      db.runs
        .where('workflowId')
        .equals(id)
        .sortBy('startedAt')
        .then(list => list.reverse()),
    [id],
    [] as RunRecord[],
  );
  const job = useLive(
    () => db.jobs.where('key').equals(`workflow:${id}`).first(),
    [id],
    undefined as JobRecord | undefined,
  );
  const [pickedRun, setPickedRun] = useState<string | null>(null);
  const shownRun = (pickedRun && runs.find(run => run.id === pickedRun)) || runs[0] || null;
  const steps = useLive(
    () => (shownRun ? db.runSteps.where('runId').equals(shownRun.id).toArray() : Promise.resolve([] as RunStep[])),
    [shownRun?.id],
    [] as RunStep[],
  );

  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'draft' | 'live'>('draft');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const draftSpec = useMemo(() => parseSpec(workflow?.draft?.spec), [workflow?.draft]);
  const confirmedSpec = useMemo(() => parseSpec(workflow?.spec), [workflow?.spec]);
  const baseSpec = useMemo(() => parseSpec(workflow?.draft?.baseSpec), [workflow?.draft]);
  const diff = useMemo(() => (draftSpec ? diffSpecs(baseSpec, draftSpec) : null), [draftSpec, baseSpec]);
  const runSpec = useMemo(() => parseSpec(shownRun?.spec), [shownRun?.spec]);

  if (workflow === null) return <div className="flex-1" />;
  if (!workflow) {
    return (
      <div className="flex flex-1 flex-col items-start gap-3 p-4">
        <p className="text-[13px]">{t('flow_gone')}</p>
        <Button size="sm" variant="glass" onClick={onBack}>
          {t('flow_back')}
        </Button>
      </div>
    );
  }

  const showingDraft = Boolean(draftSpec) && (view === 'draft' || !confirmedSpec);
  const spec = showingDraft ? draftSpec : (runSpec ?? confirmedSpec);
  const isNew = workflow.status === 'draft';
  const running = runs.some(run => OPEN.has(run.status));
  const liveRun = runs.find(run => OPEN.has(run.status));
  const waiting = showingDraft
    ? []
    : steps.filter(
        step => step.status === 'waiting_user' && step.approval === 'pending' && shownRun?.status === 'waiting_user',
      );

  const act = async (message: Record<string, unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await api.request(message);
      after?.();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  const rename = (event: FormEvent) => {
    event.preventDefault();
    const next = name.trim();
    if (!next || next === workflow.name) return setRenaming(false);
    void act({ type: 'workflow_rename', id, name: next }, () => setRenaming(false));
  };

  const nodeOf = (nodeId: string | null) => (nodeId && spec ? spec.nodes.find(node => node.id === nodeId) : undefined);
  const selectedNode = nodeOf(selected);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-start gap-1.5">
        <Button variant="ghost" size="icon" aria-label={t('flow_back')} onClick={onBack}>
          <ArrowLeft className="size-4" aria-hidden />
        </Button>
        <div className="min-w-0 flex-1 pt-1">
          {renaming ? (
            <form onSubmit={rename} className="flex gap-1.5">
              <input
                value={name}
                onChange={event => setName(event.target.value)}
                aria-label={t('flow_rename')}
                maxLength={80}
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                onKeyDown={event => event.key === 'Escape' && setRenaming(false)}
                className="border-input min-w-0 flex-1 rounded-lg border bg-transparent px-2 py-1 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ring)]"
              />
              <Button type="submit" size="sm" variant="glass" disabled={busy}>
                {t('flow_save')}
              </Button>
            </form>
          ) : (
            <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">{workflow.name}</h1>
          )}
          <p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px]">
            <StatusBadge workflow={workflow} />
            <span>{scheduleOf(workflow) ?? t('flow_trigger_byHand')}</span>
            {workflow.status === 'active' && job?.status === 'scheduled' && (
              <span>· {t('flow_next', [whenText(job.runAt)])}</span>
            )}
          </p>
        </div>
      </div>

      {workflow.description && <p className="text-muted-foreground -mt-1 px-1 text-[12.5px]">{workflow.description}</p>}

      <div className="flex flex-wrap items-center gap-1.5">
        {!isNew && !running && (
          <Button
            size="sm"
            onClick={() =>
              void act({ type: 'workflow_run', id }, () => {
                // The new run shows as it goes
                setPickedRun(null);
                setView('live');
              })
            }
            disabled={busy}>
            <Play className="size-3.5" aria-hidden />
            {t('flow_runNow')}
          </Button>
        )}
        {liveRun && (
          <Button
            size="sm"
            variant="glass"
            onClick={() => void act({ type: 'workflow_cancel_run', runId: liveRun.id })}
            disabled={busy}>
            <Square className="size-3.5" aria-hidden />
            {t('flow_stop')}
          </Button>
        )}
        {!isNew && (
          <Button
            size="sm"
            variant="glass"
            onClick={() => void act({ type: 'workflow_pause', id, paused: workflow.status === 'active' })}
            disabled={busy}>
            {workflow.status === 'active' ? (
              <Pause className="size-3.5" aria-hidden />
            ) : (
              <Play className="size-3.5" aria-hidden />
            )}
            {workflow.status === 'active' ? t('flow_pause') : t('flow_resume')}
          </Button>
        )}
        <span className="flex-1" />
        {onOpenFull && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('flow_openFull')}
            title={t('flow_openFull')}
            onClick={onOpenFull}>
            <Maximize2 className="size-3.5" aria-hidden />
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('flow_rename')}
          title={t('flow_rename')}
          onClick={() => {
            setName(workflow.name);
            setRenaming(true);
          }}>
          <Pencil className="size-3.5" aria-hidden />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('flow_delete')}
          title={t('flow_delete')}
          onClick={() => setConfirmDelete(true)}>
          <Trash2 className="size-3.5" aria-hidden />
        </Button>
      </div>

      {confirmDelete && (
        <div
          role="group"
          aria-label={t('flow_delete')}
          className="border-destructive/40 bg-destructive/10 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2">
          <p className="min-w-0 flex-1 text-[12.5px]">{t('flow_delete_confirm')}</p>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => void act({ type: 'workflow_delete', id }, onBack)}
            disabled={busy}>
            {t('flow_delete')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
            {t('flow_cancel')}
          </Button>
        </div>
      )}

      {error && (
        <div role="alert" className="border-destructive/40 bg-destructive/10 rounded-xl border px-3 py-2 text-[12.5px]">
          {error}
        </div>
      )}

      {workflow.draft && diff && (
        <section
          aria-label={isNew ? t('flow_draft_new') : t('flow_draft_change')}
          className="border-primary/30 bg-primary/5 rounded-xl border px-3 py-2.5">
          <p className="label-mono">{isNew ? t('flow_draft_new') : t('flow_draft_change')}</p>
          {workflow.draft.request && <p className="mt-1 text-[12.5px] leading-relaxed">“{workflow.draft.request}”</p>}
          <p className="text-muted-foreground mt-1.5 font-mono text-[11px]">
            {[
              diff.counts.added ? t('flow_diff_countAdded', [String(diff.counts.added)]) : null,
              diff.counts.changed ? t('flow_diff_countChanged', [String(diff.counts.changed)]) : null,
              diff.counts.removed ? t('flow_diff_countRemoved', [String(diff.counts.removed)]) : null,
            ]
              .filter(Boolean)
              .join(' · ') || t('flow_diff_none')}
          </p>
          {draftSpec && draftSpec.allowHosts.length > 0 && (
            <p className="text-muted-foreground mt-1 text-[11.5px]">
              {t('flow_reaches', [draftSpec.allowHosts.join(', ')])}
            </p>
          )}
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Button
              size="sm"
              onClick={() => void act({ type: 'workflow_confirm', id }, () => setView('live'))}
              disabled={busy}>
              <Check className="size-3.5" aria-hidden />
              {isNew ? t('flow_create') : t('flow_apply')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void act({ type: 'workflow_discard', id }, isNew ? onBack : undefined)}
              disabled={busy}>
              {t('flow_discard')}
            </Button>
            {!isNew && (
              <Button size="sm" variant="ghost" onClick={() => setView(showingDraft ? 'live' : 'draft')}>
                {showingDraft ? t('flow_showLive') : t('flow_showDraft')}
              </Button>
            )}
          </div>
        </section>
      )}

      {waiting.map(step => {
        const node = nodeOf(step.nodeId);
        return (
          <section
            key={step.id}
            aria-label={t('flow_approval_title', [node?.label ?? step.nodeId])}
            className="border-hold/50 bg-hold/10 rounded-xl border px-3 py-2.5">
            <p className="text-[13px] font-medium">{t('flow_approval_title', [node?.label ?? step.nodeId])}</p>
            <p className="text-muted-foreground mt-1 text-[12px]">
              {t('flow_approval_body')}
              {shownRun?.tainted ? ` ${t('flow_approval_tainted')}` : ''}
            </p>
            <div className="mt-2 flex gap-1.5">
              <HoldButton
                onConfirm={() =>
                  void act({ type: 'workflow_step_answer', runId: step.runId, nodeId: step.nodeId, approved: true })
                }
                armedLabel={t('flow_approval_again')}>
                {t('flow_approval_allow')}
              </HoldButton>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void act({ type: 'workflow_step_answer', runId: step.runId, nodeId: step.nodeId, approved: false })
                }>
                {t('flow_approval_decline')}
              </Button>
            </div>
          </section>
        );
      })}

      {spec ? (
        <FlowDiagram
          spec={spec}
          diff={showingDraft ? diff : null}
          steps={showingDraft ? null : steps}
          selectedId={selected}
          onSelect={setSelected}
          height={wide ? 560 : 330}
          label={t('flow_diagram_a11y', [workflow.name])}
        />
      ) : (
        <p className="text-muted-foreground text-[12.5px]">{t('flow_invalid')}</p>
      )}

      {!showingDraft && shownRun && (
        <p className="text-muted-foreground -mt-1 px-1 text-[11.5px]" aria-live="polite">
          {t('flow_showingRun', [t(STATUS_LABEL[shownRun.status]), relativeTime(shownRun.startedAt)])}
        </p>
      )}

      {selectedNode && (
        <NodeInspector
          workflowId={id}
          node={selectedNode}
          step={showingDraft ? undefined : steps.find(step => step.nodeId === selectedNode.id)}
          editable={showingDraft || !workflow.draft}
          api={api}
          onClose={() => setSelected(null)}
        />
      )}

      {runs.length > 0 && (
        <section aria-labelledby="flow-runs" className="flex flex-col gap-1">
          <h2 id="flow-runs" className="label-mono px-1">
            {t('flow_runs')}
          </h2>
          <ul className="flex flex-col">
            {runs.slice(0, 15).map(run => (
              <RunRow
                key={run.id}
                run={run}
                shown={!showingDraft && shownRun?.id === run.id}
                onShow={() => {
                  setPickedRun(run.id);
                  setView('live');
                }}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
