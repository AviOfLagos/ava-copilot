import { useMemo, useSyncExternalStore } from 'react';
import { Download, ExternalLink, Loader2 } from 'lucide-react';
import { t } from '@extension/i18n';
import { Button } from '../components/ui/button';
import { DownloadBar } from '../voice-models/VoiceModelsCard';
import { createRequirementFlow } from './flow';
import type { FlowState, Requirement, RequirementFlow } from './flow';

/** Megabytes or gigabytes, rounded for people. */
export function sizeText(bytes: number | undefined): string {
  if (!bytes) return '';
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** The suffix an option that needs installing carries in a select: " · Install (28 MB)". */
export function installSuffix(bytes?: number): string {
  const size = sizeText(bytes);
  return ` · ${size ? t('requirement_option_installSized', [size]) : t('requirement_option_install')}`;
}

/** One flow per setting, its state for rendering, and `choose` for its onChange. */
export function useRequirementFlow(): { flow: RequirementFlow; state: FlowState } {
  const flow = useMemo(() => createRequirementFlow({ notReady: t('requirement_notReady') }), []);
  const state = useSyncExternalStore(flow.subscribe, flow.getState);
  return { flow, state };
}

function progressLine(state: FlowState): string {
  const progress = state.progress;
  if (!progress?.total) return progress?.status ?? t('requirement_starting');
  const percent = Math.floor((progress.received / progress.total) * 100);
  return t('requirement_progress', [sizeText(progress.received) || '0 MB', sizeText(progress.total), String(percent)]);
}

/**
 * The small card under a setting whose choice needs something installed: what and how big, Install / Cancel,
 * progress with Cancel, a retry when it failed, or the steps for what only the user can do. The choice is saved by
 * the flow once the requirement is ready; Cancel keeps the old one.
 */
export function RequirementCard({ flow, state }: { flow: RequirementFlow; state: FlowState }) {
  const requirement = state.requirement;
  if (state.phase === 'idle' || !requirement) return null;
  if (state.phase === 'checking' && !state.error && !state.progress) {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 px-3 pb-2.5 text-[11.5px]" role="status">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {t('requirement_checking', [requirement.label])}
      </p>
    );
  }
  const size = sizeText(requirement.sizeBytes);
  const title = size
    ? t('requirement_needs_sized', [requirement.label, size])
    : t('requirement_needs', [requirement.label]);
  const installing = state.phase === 'installing';
  const manual = !requirement.install;
  const headingId = `requirement-${requirement.id.replace(/[^a-z0-9]+/gi, '-')}`;

  return (
    <section
      aria-labelledby={headingId}
      data-testid="requirement-card"
      data-requirement={requirement.id}
      className="border-primary/30 bg-primary/5 mx-3 mb-2.5 rounded-xl border p-2.5 text-[12px]">
      <div className="flex items-center gap-2">
        <Download className="text-primary size-3.5 shrink-0" aria-hidden />
        <h4 id={headingId} className="min-w-0 flex-1 text-[12.5px] font-medium">
          {title}
        </h4>
      </div>
      <p className="text-muted-foreground mt-0.5 text-[11.5px]">
        {t(manual ? 'requirement_body_manual' : 'requirement_body')}
      </p>

      {manual && requirement.steps && (
        <ol className="text-muted-foreground mt-1.5 list-decimal space-y-0.5 pl-4 text-[11.5px]">
          {requirement.steps.map(step => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}

      {installing && (
        <div className="mt-2 flex flex-col gap-1.5" role="status">
          <DownloadBar
            download={{
              phase: 'downloading',
              ids: [],
              received: state.progress?.received ?? 0,
              total: state.progress?.total ?? 0,
            }}
            label={title}
          />
          <span className="text-muted-foreground" data-testid="requirement-progress">
            {progressLine(state)}
          </span>
        </div>
      )}

      {state.phase === 'failed' && state.error && (
        <p role="alert" className="border-destructive/50 bg-destructive/15 mt-2 rounded-lg border px-2 py-1">
          {state.error}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
        {manual && requirement.link && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void chrome.tabs.create({ url: requirement.link!.url }).catch(() => {})}>
            <ExternalLink className="size-3.5" aria-hidden />
            {requirement.link.label}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => flow.cancel()}>
          {t('requirement_cancel')}
        </Button>
        {!installing &&
          (manual ? (
            <Button size="sm" disabled={state.phase === 'checking'} onClick={() => void flow.recheck()}>
              {t('requirement_checkAgain')}
            </Button>
          ) : (
            <Button size="sm" onClick={() => void flow.install()}>
              {t(state.phase === 'failed' ? 'requirement_retry' : 'requirement_install')}
            </Button>
          ))}
      </div>
    </section>
  );
}

export type { Requirement };
