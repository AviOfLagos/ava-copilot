import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { t } from '@extension/i18n';
import { updateStatusStore } from '@src/background/update/state';
import type { UpdateStatus } from '@src/background/update/state';
import { openSettingsPage } from '@src/shared/lib/settings-page';
import type { PanelApi } from '../registry';

/**
 * "Ava Copilot 1.4 is available — What's new · Update": dismissible, and only while a newer version than the
 * one actually installed (`chrome.runtime.getManifest().version`, compared in the background) exists. The
 * background does the checking and the deciding (src/background/update/register.ts); this only reads its
 * stored result and reacts to the two clicks.
 */

function useUpdateStatus(): UpdateStatus | null {
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
  return status;
}

export default function UpdateBanner({ api }: { api: PanelApi }) {
  const status = useUpdateStatus();
  const [notesOpen, setNotesOpen] = useState(false);

  if (!status?.extensionUpdateAvailable || !status.info) return null;
  const version = status.info.version;
  if (status.bannerDismissedVersion === version) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-update-banner
      className="glass mx-2.5 mt-2 flex flex-col gap-1.5 rounded-xl px-3 py-2.5 text-[12.5px]">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1">{t('update_banner_available', [`${t('app_metadata_name')} ${version}`])}</p>
        <button
          type="button"
          aria-label={t('update_banner_dismiss')}
          className="text-muted-foreground hover:text-foreground -m-1 shrink-0 rounded p-1"
          onClick={() => void api.post({ type: 'update_dismiss_banner', version })}>
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="text-primary underline-offset-2 hover:underline"
          onClick={() => setNotesOpen(open => !open)}
          aria-expanded={notesOpen}>
          {t('update_banner_whatsNew')}
        </button>
        <button
          type="button"
          className="text-primary underline-offset-2 hover:underline"
          onClick={() => void openSettingsPage('help/updates')}>
          {t('update_banner_update')}
        </button>
      </div>
      {notesOpen && (
        <ul className="text-muted-foreground list-disc space-y-0.5 pl-4" aria-label={t('update_banner_whatsNew')}>
          {status.info.notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
