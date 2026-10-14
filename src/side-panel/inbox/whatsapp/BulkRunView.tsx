import { useEffect, useState } from 'react';
import { Download, Pause, Play, Square, Trash2, X } from 'lucide-react';
import { t } from '@extension/i18n';
import type { BulkRun } from '@extension/storage';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { HoldButton } from '../../components/ui/hold-button';
import type { PanelApi } from '../../registry';
import { counts, reasonText, reportCsv, statusText, useRemainingToday } from './useBulk';

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function runStatusLine(run: BulkRun, now: number): string {
  switch (run.status) {
    case 'running': {
      const seconds = run.nextAt ? Math.max(0, Math.ceil((run.nextAt - now) / 1000)) : 0;
      return seconds > 0 ? t('inbox_wa_run_next', [String(seconds)]) : t('inbox_wa_run_sending');
    }
    case 'paused':
      return run.note === 'daily_cap' ? t('inbox_wa_run_pausedCap') : t('inbox_wa_run_paused');
    case 'waiting_tab':
      return run.note === 'logged_out' ? t('inbox_wa_note_loggedOut_body') : t('inbox_wa_note_tabClosed_body');
    case 'done':
      return t('inbox_wa_run_done');
    case 'stopped':
      return t('inbox_wa_run_stopped');
    case 'declined':
      return t('inbox_wa_run_declined');
    default:
      return '';
  }
}

function download(run: BulkRun) {
  const blob = new Blob([`\uFEFF${reportCsv(run)}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `whatsapp-report-${new Date(run.createdAt).toISOString().slice(0, 10)}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const STATUS_COLOR: Record<string, string> = {
  sent: 'text-primary',
  failed: 'text-destructive',
  skipped: 'text-muted-foreground',
  sending: 'text-foreground',
  pending: 'text-muted-foreground',
};

/** A batch: its review and approval, its progress with pause/resume/stop, or its report. */
export default function BulkRunView({ run, api, onNew }: { run: BulkRun; api: PanelApi; onNew: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = ['running', 'paused', 'waiting_tab'].includes(run.status);
  const now = useNow(run.status === 'running');
  const tally = counts(run);
  const remaining = useRemainingToday(run.settings.dailyCap);
  const toSend = tally.pending;

  const send = async (message: Record<string, unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await api.request({ ...message, runId: run.id });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  const unknown = run.note.startsWith('unknown:') ? run.note.slice('unknown:'.length) : '';

  return (
    <div className="flex flex-col gap-3">
      {run.status === 'awaiting_approval' ? (
        <>
          <header>
            <h3 className="text-[13.5px] font-semibold">{t('inbox_wa_review_title', [String(toSend)])}</h3>
            <p className="text-muted-foreground mt-0.5 text-[12px] leading-relaxed">{t('inbox_wa_review_body')}</p>
          </header>
          <div
            role="note"
            className="border-destructive/40 bg-destructive/10 rounded-xl border px-3 py-2 text-[12px] leading-relaxed">
            {t('inbox_wa_bulk_warning')}
          </div>
          <p className="text-muted-foreground text-[11.5px]">
            {t('inbox_wa_review_pacing', [
              String(run.settings.delayMinSec),
              String(run.settings.delayMaxSec),
              String(run.settings.cooldownEvery),
              String(run.settings.cooldownMinSec),
              String(run.settings.cooldownMaxSec),
            ])}
          </p>
          {toSend > remaining && (
            <p role="alert" className="text-[11.5px] font-medium">
              {t('inbox_wa_review_overCap', [String(remaining), String(run.settings.dailyCap)])}
            </p>
          )}
          {unknown && (
            <p role="alert" className="text-destructive text-[11.5px]">
              {t('inbox_wa_bulk_unknownPlaceholders', [unknown])}
            </p>
          )}
          {run.attachment && <p className="text-[11.5px]">{t('inbox_wa_review_attachment', [run.attachment.name])}</p>}
        </>
      ) : (
        <header className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{t('inbox_wa_count_sent', [String(tally.sent)])}</Badge>
            <Badge variant="outline">{t('inbox_wa_count_failed', [String(tally.failed)])}</Badge>
            <Badge variant="outline">{t('inbox_wa_count_skipped', [String(tally.skipped)])}</Badge>
            {live && (
              <Badge variant="outline">{t('inbox_wa_count_left', [String(tally.pending + tally.sending)])}</Badge>
            )}
          </div>
          <p aria-live="polite" className="text-[12.5px]" data-testid="wa-run-status">
            {runStatusLine(run, now)}
          </p>
        </header>
      )}

      <ul className="flex flex-col gap-1.5" aria-label={t('inbox_wa_review_list')}>
        {run.recipients.map((recipient, index) => (
          <li key={`${recipient.phone}-${index}`} className="glass rounded-xl px-3 py-2">
            <div className="flex items-baseline justify-between gap-2">
              <p className="min-w-0 truncate text-[11.5px] font-medium">
                {recipient.name || recipient.phone}{' '}
                <span className="text-muted-foreground font-mono font-normal">+{recipient.phone}</span>
              </p>
              <span className={`shrink-0 text-[10.5px] ${STATUS_COLOR[recipient.status]}`}>
                {statusText(recipient.status)}
              </span>
            </div>
            {recipient.message && recipient.status !== 'skipped' && (
              <p className="mt-0.5 whitespace-pre-wrap text-[12px] leading-relaxed">{recipient.message}</p>
            )}
            {recipient.reason && (
              <p className="text-muted-foreground mt-0.5 text-[11.5px]">{reasonText(recipient.reason)}</p>
            )}
          </li>
        ))}
      </ul>

      {error && (
        <div role="alert" className="border-destructive/40 bg-destructive/10 rounded-xl border px-3 py-2 text-[12.5px]">
          {error}
        </div>
      )}

      <div className="bg-background/80 sticky bottom-0 flex flex-wrap gap-1.5 py-2 backdrop-blur">
        {run.status === 'awaiting_approval' && (
          <>
            <HoldButton
              className="flex-1"
              armedLabel={t('inbox_wa_review_confirm')}
              onConfirm={() => void send({ type: 'wa_bulk_answer', approvalId: run.approvalId, approved: true })}>
              {t('inbox_wa_review_approve', [String(toSend)])}
            </HoldButton>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void send({ type: 'wa_bulk_answer', approvalId: run.approvalId, approved: false })}>
              <X className="size-3.5" aria-hidden />
              {t('inbox_wa_review_cancel')}
            </Button>
          </>
        )}
        {(run.status === 'running' || run.status === 'waiting_tab') && (
          <Button variant="glass" size="sm" disabled={busy} onClick={() => void send({ type: 'wa_bulk_pause' })}>
            <Pause className="size-3.5" aria-hidden />
            {t('inbox_wa_run_pause')}
          </Button>
        )}
        {(run.status === 'paused' || run.status === 'waiting_tab') && (
          <Button variant="glass" size="sm" disabled={busy} onClick={() => void send({ type: 'wa_bulk_resume' })}>
            <Play className="size-3.5" aria-hidden />
            {t('inbox_wa_run_resume')}
          </Button>
        )}
        {live && (
          <Button variant="destructive" size="sm" disabled={busy} onClick={() => void send({ type: 'wa_bulk_stop' })}>
            <Square className="size-3.5" aria-hidden />
            {t('inbox_wa_run_stop')}
          </Button>
        )}
        {!live && run.status !== 'awaiting_approval' && (
          <>
            <Button variant="glass" size="sm" onClick={() => download(run)}>
              <Download className="size-3.5" aria-hidden />
              {t('inbox_wa_run_export')}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void send({ type: 'wa_bulk_delete' })}>
              <Trash2 className="size-3.5" aria-hidden />
              {t('inbox_wa_run_delete')}
            </Button>
            <Button size="sm" onClick={onNew}>
              {t('inbox_wa_run_new')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
