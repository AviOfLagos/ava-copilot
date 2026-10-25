import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import { updateSettingsStore, updateStatusStore } from '@src/background/update/state';
import type { UpdateSettings as UpdateSettingsValue, UpdateStatus } from '@src/background/update/state';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { CopyCommand } from '../models/LocalSection';
import type { PanelApi } from '../registry';
import { HINT, Row } from '../settings/sections/ui';

/**
 * Settings › Help's "Updates": the setting (default on, explained plainly so "no third-party calls" stays
 * true — this is Ava Copilot's own site), the current vs. latest version, what changed, and the two things an
 * update actually is: the install command again (updates in place) and a Reload button, plus the same for Nex
 * Brain. The background does the checking (src/background/update/register.ts); this only sends commands and
 * reads what it found.
 */

function useUpdateState() {
  const [settings, setSettings] = useState<UpdateSettingsValue | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    const load = () => {
      void updateSettingsStore.getSettings().then(setSettings);
      void updateStatusStore.getStatus().then(setStatus);
    };
    load();
    const stopSettings = updateSettingsStore.subscribe(load);
    const stopStatus = updateStatusStore.subscribe(load);
    return () => {
      stopSettings();
      stopStatus();
    };
  }, []);
  return { settings, status };
}

export default function UpdateSettings({ api }: { api: PanelApi }) {
  const { settings, status } = useUpdateState();
  const [checking, setChecking] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const localVersion = chrome.runtime.getManifest().version;

  const checkNow = useCallback(async () => {
    setChecking(true);
    try {
      await api.request({ type: 'update_check_now' }, 15_000);
    } catch {
      // The error already lands in `status.error`, read below; nothing else to do with it here
    } finally {
      setChecking(false);
    }
  }, [api]);

  if (!settings || !status) return null;
  const info = status.info;

  return (
    <>
      <Row title={t('update_settings_checkEnabled_label')} hint={t('update_settings_checkEnabled_hint')}>
        <Switch
          label={t('update_settings_checkEnabled_label')}
          checked={settings.checkEnabled}
          onChange={value => void api.request({ type: 'update_set_enabled', checkEnabled: value })}
        />
      </Row>

      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-[13px]">{t('update_settings_current', [localVersion])}</p>
          <p className={HINT} role="status" aria-live="polite">
            {status.error
              ? t('update_settings_error', [status.error])
              : !info
                ? t('update_settings_checking')
                : status.extensionUpdateAvailable
                  ? t('update_settings_latest', [info.version, info.released])
                  : t('update_settings_upToDate')}
          </p>
        </div>
        <Button variant="glass" size="sm" disabled={checking} onClick={() => void checkNow()}>
          <RefreshCw className={cn('size-3.5', checking && 'animate-spin')} aria-hidden />
          {t('update_settings_checkNow')}
        </Button>
      </div>

      {info && status.extensionUpdateAvailable && (
        <div className="flex flex-col gap-2 px-3 py-2.5">
          <button
            type="button"
            className="text-primary self-start underline-offset-2 hover:underline"
            onClick={() => setNotesOpen(open => !open)}
            aria-expanded={notesOpen}>
            {t('update_settings_whatsNew')}
          </button>
          {notesOpen && (
            <ul className="text-muted-foreground list-disc space-y-0.5 pl-4" aria-label={t('update_settings_whatsNew')}>
              {info.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          )}
          <p className="text-[13px]">{t('update_settings_install_title')}</p>
          <p className={HINT}>{t('update_settings_install_step')}</p>
          <CopyCommand command={info.extension.command} />
          <Button size="sm" onClick={() => chrome.runtime.reload()}>
            {t('update_settings_reload')}
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-1.5 px-3 py-2.5">
        <p className="text-[13px]">{t('update_settings_brain_title')}</p>
        <p className={HINT}>
          {!info
            ? t('update_settings_checking')
            : !status.brainVersion
              ? t('update_settings_brain_unknown')
              : status.brainUpdateAvailable
                ? t('update_settings_brain_latest', [info.brain.version])
                : t('update_settings_brain_upToDate')}
        </p>
        {status.brainVersion && <p className={HINT}>{t('update_settings_brain_current', [status.brainVersion])}</p>}
        {info && status.brainUpdateAvailable && <CopyCommand command={info.brain.command} />}
      </div>
    </>
  );
}
