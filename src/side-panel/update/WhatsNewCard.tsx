import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { t } from '@extension/i18n';
import { updateStatusStore } from '@src/background/update/state';
import type { UpdateStatus } from '@src/background/update/state';
import { openSettingsPage } from '@src/shared/lib/settings-page';
import type { PanelApi } from '../registry';

/**
 * "Updated to Ava Copilot 0.2.1 — what's new": shown once after the extension updates (the background records the
 * version change on install, src/background/update/register.ts) until the user closes it. The notes are the
 * feed's, when the feed describes this version; otherwise the card links to Settings › Help › Updates.
 */
export default function WhatsNewCard({ api }: { api: PanelApi }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => void updateStatusStore.getStatus().then(next => alive && setStatus(next));
    load();
    const stop = updateStatusStore.subscribe(load);
    return () => {
      alive = false;
      stop();
    };
  }, []);

  const updated = status?.justUpdated;
  if (!updated || updated.to !== chrome.runtime.getManifest().version) return null;
  const notes = status.info?.version === updated.to ? status.info.notes : [];
  const close = () => void api.post({ type: 'update_whatsnew_seen' });

  return (
    <section
      role="status"
      aria-live="polite"
      aria-labelledby="whatsnew-title"
      data-whats-new
      className="glass border-primary/30 mx-2.5 mt-2 flex flex-col gap-2 rounded-xl border px-3 py-3 text-[12.5px]">
      <div className="flex items-start gap-2.5">
        <span className="bg-primary/15 text-primary grid size-7 shrink-0 place-items-center rounded-lg" aria-hidden>
          <Sparkles className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p id="whatsnew-title" className="text-[13px] font-semibold">
            {t('whatsnew_title', [`${t('app_metadata_name')} ${updated.to}`])}
          </p>
          <p className="text-muted-foreground">{t('whatsnew_from', [updated.from])}</p>
        </div>
        <button
          type="button"
          aria-label={t('whatsnew_close')}
          className="text-muted-foreground hover:text-foreground -m-1 shrink-0 rounded p-1"
          onClick={close}>
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      {notes.length > 0 ? (
        <ul className="list-disc space-y-1 pl-4" aria-label={t('update_banner_whatsNew')}>
          {notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{t('whatsnew_noNotes')}</p>
      )}
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="bg-primary/15 hover:bg-primary/25 rounded-full px-3 py-1 font-medium"
          onClick={close}>
          {t('whatsnew_ok')}
        </button>
        <button
          type="button"
          className="text-primary underline-offset-2 hover:underline"
          onClick={() => void openSettingsPage('help/updates')}>
          {t('whatsnew_more')}
        </button>
      </div>
    </section>
  );
}
