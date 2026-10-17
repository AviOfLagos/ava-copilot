import { Download, X } from 'lucide-react';
import { t } from '@extension/i18n';
import { Button } from '../components/ui/button';
import { bytesFor, cancelDownload, clearDownloadError, megabytes, startDownload, useDownloadState } from './downloads';
import type { DownloadErrorKind, DownloadState } from './downloads';
import { gateCancel, gateDecline, gateReady, useGateRequest } from './gate';
import type { CardPlacement } from './gate';

const ERRORS: Record<DownloadErrorKind, Parameters<typeof t>[0]> = {
  network: 'voice_models_error_network',
  checksum: 'voice_models_error_checksum',
  space: 'voice_models_error_space',
  other: 'voice_models_error_other',
};

export function progressText(download: Pick<DownloadState, 'received' | 'total'>): string {
  const percent = download.total ? Math.floor((download.received / download.total) * 100) : 0;
  return t('voice_models_progress', [
    String(Math.round(download.received / 1e6)),
    String(megabytes(download.total)),
    String(percent),
  ]);
}

/** A progress bar for a download. */
export function DownloadBar({ download, label }: { download: DownloadState; label: string }) {
  const percent = download.total ? Math.floor((download.received / download.total) * 100) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
    </div>
  );
}

/**
 * The first time Talk, dictation or the wake word needs local models that are not here yet: what it downloads
 * (size, once), its progress with a cancel, and a retry when it fails. When it is ready the feature starts by
 * itself.
 */
export default function VoiceModelsCard({ placement = 'panel' }: { placement?: CardPlacement }) {
  const request = useGateRequest();
  const download = useDownloadState();
  if (!request || request.placement !== placement) return null;

  const ids = [...request.required, ...request.optional];
  const mb = String(megabytes(bytesFor(ids)));
  const title =
    request.feature === 'wake' ? t('voice_models_card_titleWake', [mb]) : t('voice_models_card_title', [mb]);
  const downloading = download.phase === 'downloading';
  const failed = download.phase === 'failed';
  const changed = () => request.request({ type: 'voice_models_changed' });

  const begin = async () => {
    clearDownloadError();
    if (await startDownload(ids, changed)) gateReady();
  };
  const dismiss = () => {
    clearDownloadError();
    gateDecline();
  };
  const stop = () => {
    cancelDownload();
    gateCancel();
  };

  return (
    <section
      aria-labelledby="voice-models-card-title"
      data-testid="voice-models-card"
      className={`glass rounded-2xl border border-primary/30 p-3 text-[12.5px] ${placement === 'panel' ? 'mx-2.5 mt-2' : ''}`}>
      <div className="flex items-center gap-2">
        <Download className="size-4 shrink-0 text-primary" aria-hidden />
        <h2 id="voice-models-card-title" className="min-w-0 flex-1 text-[13px] font-semibold">
          {title}
        </h2>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t(downloading ? 'voice_models_cancel' : 'voice_models_notNow')}
          onClick={downloading ? stop : dismiss}>
          <X className="size-3.5" aria-hidden />
        </Button>
      </div>
      <p className="mt-1 text-muted-foreground">
        {t(request.feature === 'wake' ? 'voice_models_card_bodyWake' : 'voice_models_card_body')}
      </p>

      {downloading && (
        <div className="mt-2 flex flex-col gap-1.5" role="status">
          <DownloadBar download={download} label={title} />
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-muted-foreground" data-testid="voice-models-progress">
              {progressText(download)}
            </span>
            <Button size="sm" variant="ghost" onClick={stop}>
              {t('voice_models_cancel')}
            </Button>
          </div>
        </div>
      )}

      {failed && (
        <p role="alert" className="mt-2 rounded-xl border border-destructive/50 bg-destructive/15 px-2.5 py-1.5">
          {t(ERRORS[download.error ?? 'other'])}
        </p>
      )}

      {!downloading && (
        <div className="mt-2 flex items-center justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={dismiss}>
            {t('voice_models_notNow')}
          </Button>
          <Button size="sm" onClick={() => void begin()}>
            {t(failed ? 'voice_models_retry' : 'voice_models_download')}
          </Button>
        </div>
      )}
    </section>
  );
}
