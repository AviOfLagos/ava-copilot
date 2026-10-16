import { useState } from 'react';
import type { FormEvent } from 'react';
import { ChevronRight, Newspaper, Plus, Video } from 'lucide-react';
import { t } from '@extension/i18n';
import { db } from '@extension/storage';
import type { JobRecord, WorkflowRecord } from '@extension/storage';
import { cn } from '@extension/ui';
import { parseSpec } from '@src/background/workflows/spec';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { useLive } from '../hooks/useLive';
import type { PanelApi } from '../registry';
import { relativeTime, STATUS_LABEL, statusTone, triggerSummary, whenText } from './meta';
import WorkflowDetail from './WorkflowDetail';

/**
 * Workflows: routines that run on their own. The list puts what waits for the user's review first, then
 * their workflows with when they run next and how the last run went; a workflow opens on its diagram.
 */

/** When a workflow runs, from what runs now (or its draft, before it is created). */
export function scheduleOf(workflow: WorkflowRecord): string {
  const spec = parseSpec(workflow.spec) ?? parseSpec(workflow.draft?.spec);
  return spec ? triggerSummary(spec) : t('flow_trigger_byHand');
}

export function StatusBadge({ workflow }: { workflow: WorkflowRecord }) {
  if (workflow.status === 'draft') return <Badge variant="outline">{t('flow_state_draft')}</Badge>;
  if (workflow.status === 'paused') return <Badge variant="secondary">{t('flow_state_paused')}</Badge>;
  return <Badge>{t('flow_state_active')}</Badge>;
}

function WorkflowRow({ workflow, job, onOpen }: { workflow: WorkflowRecord; job?: JobRecord; onOpen: () => void }) {
  const parts = [
    scheduleOf(workflow),
    workflow.status === 'active' && job?.status === 'scheduled' ? t('flow_next', [whenText(job.runAt)]) : null,
    workflow.lastRunAt && workflow.lastRunStatus
      ? t('flow_last', [t(STATUS_LABEL[workflow.lastRunStatus]), relativeTime(workflow.lastRunAt)])
      : null,
  ].filter(Boolean);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-workflow={workflow.name}
        className="glass hover:bg-accent flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors">
        <span className={cn('mt-[7px] size-2 shrink-0 rounded-full', statusTone(workflow.lastRunStatus))} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium">{workflow.name}</span>
            <StatusBadge workflow={workflow} />
            {workflow.draft && workflow.status !== 'draft' && <Badge variant="outline">{t('flow_state_change')}</Badge>}
          </span>
          <span className="text-muted-foreground mt-0.5 block truncate text-[11.5px]">{parts.join(' · ')}</span>
        </span>
        <ChevronRight className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
      </button>
    </li>
  );
}

/**
 * "New workflow" where there is no chat to ask in (the full-tab editor): the user describes the routine here and gets
 * the draft's diagram, written by the same authoring as chat. Nothing runs before they click Create.
 */
function DescribeWorkflow({
  api,
  onOpen,
  onCancel,
}: {
  api: PanelApi;
  onOpen: (id: string) => void;
  onCancel: () => void;
}) {
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (request.trim().length < 3 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const reply = await api.request<{ id: string }>({ type: 'workflow_draft', request: request.trim() }, 120_000);
      onOpen(reply.id);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="glass flex flex-col gap-2 rounded-xl px-3 py-2.5" data-describe-workflow>
      <label className="flex flex-col gap-1.5 text-[12px]">
        <span className="font-medium">{t('flow_describe_label')}</span>
        <textarea
          value={request}
          onChange={event => setRequest(event.target.value)}
          onKeyDown={event => event.key === 'Escape' && onCancel()}
          placeholder={t('flow_describe_placeholder')}
          rows={3}
          maxLength={2000}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          className="border-input w-full resize-y rounded-lg border bg-transparent px-2 py-1.5 text-[12.5px] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ring)]"
        />
      </label>
      <p className="text-muted-foreground text-[11.5px]">{t('flow_describe_hint')}</p>
      {error && (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      )}
      <div className="flex gap-1.5">
        <Button type="submit" size="sm" disabled={busy || request.trim().length < 3}>
          {busy ? t('flow_describe_busy') : t('flow_describe_submit')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          {t('flow_cancel')}
        </Button>
      </div>
    </form>
  );
}

function WorkflowList({
  api,
  onOpen,
  describeHere = false,
}: {
  api: PanelApi;
  onOpen: (id: string) => void;
  // Ask for a new routine on this page instead of in a chat (the full-tab editor has no chat)
  describeHere?: boolean;
}) {
  const [describing, setDescribing] = useState(false);
  const workflows = useLive(() => db.workflows.toArray(), [], [] as WorkflowRecord[]);
  const jobs = useLive(() => db.jobs.where('kind').equals('workflow').toArray(), [], [] as JobRecord[]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const jobOf = (id: string) => jobs.find(job => job.key === `workflow:${id}`);

  const review = workflows
    .filter(workflow => workflow.draft)
    .sort((a, b) => (b.draft?.createdAt ?? 0) - (a.draft?.createdAt ?? 0));
  const others = workflows.filter(workflow => !workflow.draft).sort((a, b) => b.updatedAt - a.updatedAt);

  const fromTemplate = async (template: 'morning_tech_news' | 'meeting_links') => {
    setBusy(true);
    setError(null);
    try {
      const reply = await api.request<{ id: string }>({ type: 'workflow_template', template });
      onOpen(reply.id);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
      <header className="px-1">
        <h1 className="text-[15px] font-semibold tracking-[-0.01em]">{t('flow_title')}</h1>
        <p className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">{t('flow_intro')}</p>
      </header>

      {describing ? (
        <DescribeWorkflow api={api} onOpen={onOpen} onCancel={() => setDescribing(false)} />
      ) : (
        <Button
          onClick={() => (describeHere ? setDescribing(true) : api.startThread(`${t('flow_new_starter')} `))}
          className="w-full justify-center"
          data-new-workflow>
          <Plus className="size-4" aria-hidden />
          {t('flow_new')}
        </Button>
      )}

      {error && (
        <div role="alert" className="border-destructive/40 bg-destructive/10 rounded-xl border px-3 py-2 text-[12.5px]">
          {error}
        </div>
      )}

      {review.length > 0 && (
        <section aria-labelledby="flow-review" className="flex flex-col gap-1.5">
          <h2 id="flow-review" className="label-mono px-1">
            {t('flow_section_review')}
          </h2>
          <ul className="flex flex-col gap-1.5">
            {review.map(workflow => (
              <WorkflowRow
                key={workflow.id}
                workflow={workflow}
                job={jobOf(workflow.id)}
                onOpen={() => onOpen(workflow.id)}
              />
            ))}
          </ul>
        </section>
      )}

      {others.length > 0 && (
        <section aria-labelledby="flow-yours" className="flex flex-col gap-1.5">
          <h2 id="flow-yours" className="label-mono px-1">
            {t('flow_section_yours')}
          </h2>
          <ul className="flex flex-col gap-1.5">
            {others.map(workflow => (
              <WorkflowRow
                key={workflow.id}
                workflow={workflow}
                job={jobOf(workflow.id)}
                onOpen={() => onOpen(workflow.id)}
              />
            ))}
          </ul>
        </section>
      )}

      {workflows.length === 0 && (
        <div className="glass rounded-2xl px-4 py-5">
          <p className="text-[13px] font-medium">{t('flow_empty_title')}</p>
          <p className="text-muted-foreground mt-1.5 text-[12.5px] leading-relaxed">{t('flow_empty_body')}</p>
          <p className="bg-secondary mt-2.5 rounded-lg px-2.5 py-2 font-mono text-[11.5px] leading-relaxed">
            {t('flow_empty_example')}
          </p>
        </div>
      )}

      <section aria-labelledby="flow-templates" className="flex flex-col gap-1.5">
        <h2 id="flow-templates" className="label-mono px-1">
          {t('flow_section_templates')}
        </h2>
        <div className="glass flex items-center gap-3 rounded-xl px-3 py-2.5">
          <span className="bg-primary/15 flex size-8 shrink-0 items-center justify-center rounded-lg">
            <Newspaper className="size-4" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">{t('flow_template_news')}</span>
            <span className="text-muted-foreground block text-[11.5px]">{t('flow_template_news_hint')}</span>
          </span>
          <Button
            size="sm"
            variant="glass"
            onClick={() => void fromTemplate('morning_tech_news')}
            disabled={busy}
            aria-label={t('flow_template_use_a11y')}>
            <Plus className="size-3.5" aria-hidden />
            {t('flow_template_use')}
          </Button>
        </div>
        <div className="glass flex items-center gap-3 rounded-xl px-3 py-2.5">
          <span className="bg-primary/15 flex size-8 shrink-0 items-center justify-center rounded-lg">
            <Video className="size-4" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">{t('flow_template_meetings')}</span>
            <span className="text-muted-foreground block text-[11.5px]">{t('flow_template_meetings_hint')}</span>
          </span>
          <Button
            size="sm"
            variant="glass"
            onClick={() => void fromTemplate('meeting_links')}
            disabled={busy}
            aria-label={t('flow_template_meetings_a11y')}>
            <Plus className="size-3.5" aria-hidden />
            {t('flow_template_use')}
          </Button>
        </div>
      </section>
    </div>
  );
}

export interface WorkflowsPlaceProps {
  api: PanelApi;
  // The full-tab editor: a bigger diagram, and no way back to the list it opened from
  initialId?: string | null;
  wide?: boolean;
  onOpenFull?: (id: string) => void;
}

/** The Workflows place: the list, or one workflow with its diagram. */
export function WorkflowsView({ api, initialId = null, wide = false, onOpenFull }: WorkflowsPlaceProps) {
  const [openId, setOpenId] = useState<string | null>(initialId);
  if (openId) {
    return (
      <WorkflowDetail
        key={openId}
        id={openId}
        api={api}
        wide={wide}
        onBack={() => setOpenId(null)}
        onOpenFull={onOpenFull ? () => onOpenFull(openId) : undefined}
      />
    );
  }
  return <WorkflowList api={api} onOpen={setOpenId} describeHere={wide} />;
}

export default function WorkflowsPlace({ api }: { api: PanelApi }) {
  const openFull = (id: string) =>
    void chrome.tabs.create({ url: chrome.runtime.getURL(`workflows.html#${encodeURIComponent(id)}`) });
  return <WorkflowsView api={api} onOpenFull={openFull} />;
}
