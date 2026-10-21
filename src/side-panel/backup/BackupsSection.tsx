import { useCallback, useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { brainSettingsStore } from '@src/background/companion/state';
import { backupSettingsStore, backupStatusStore } from '@src/background/backup/state';
import type { BackupSettings, BackupStatus } from '@src/background/backup/state';
import type { BackupMeta } from '@src/shared/lib/protocol/companion';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import type { PanelApi } from '../registry';
import { HINT, Row } from '../settings/sections/ui';
import { BackupList, megabytes, when } from './BackupList';

/**
 * Settings › Memory › Backups: memory and settings kept by Nex Brain on this Mac, so a reinstall brings them back.
 * Backups run on their own (a few minutes after changes, and daily); this shows the last one, backs up by hand,
 * lists what the Mac keeps, and restores one after a confirm.
 */
export default function BackupsSection({ api }: { api: PanelApi }) {
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [paired, setPaired] = useState(false);
  const [snapshots, setSnapshots] = useState<BackupMeta[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => {
      void backupSettingsStore.getSettings().then(setSettings);
      void backupStatusStore.getStatus().then(setStatus);
      void brainSettingsStore.getSettings().then(value => setPaired(value.paired));
    };
    load();
    const stops = [
      backupSettingsStore.subscribe(load),
      backupStatusStore.subscribe(load),
      brainSettingsStore.subscribe(load),
    ];
    return () => stops.forEach(stop => stop());
  }, []);

  const loadList = useCallback(async () => {
    setError(null);
    try {
      const reply = await api.request<{ snapshots: BackupMeta[] }>({ type: 'backup_list' }, 20_000);
      setSnapshots(reply.snapshots);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [api]);

  useEffect(() => {
    if (paired) void loadList();
  }, [paired, loadList, status?.lastSnapshotId]);

  if (!settings || !status) return null;

  const backUp = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.request({ type: 'backup_now' }, 10 * 60_000);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const last = status.running
    ? t('backup_running')
    : status.lastBackupAt
      ? t('backup_last', [when(status.lastBackupAt), megabytes(status.lastBytes ?? 0)])
      : t('backup_never');

  return (
    <div className="space-y-1">
      <p className={`${HINT} px-3 pt-3`}>{t('backup_desc')}</p>
      {!paired ? (
        <p className={`${HINT} px-3 pb-3`} data-testid="backup-not-paired">
          {t('backup_notPaired')}
        </p>
      ) : (
        <>
          <Row
            title={last}
            hint={
              status.lastError ? (
                <span className="text-destructive" role="alert">
                  {t('backup_error', [status.lastError])}
                </span>
              ) : undefined
            }>
            <Button size="sm" variant="glass" disabled={busy || status.running} onClick={() => void backUp()}>
              {busy ? t('backup_running') : t('backup_now')}
            </Button>
          </Row>
          <Row title={t('backup_includeSecrets')} hint={t('backup_includeSecrets_hint')}>
            <Switch
              label={t('backup_includeSecrets')}
              checked={settings.includeSecrets}
              onChange={value => void api.request({ type: 'backup_set', includeSecrets: value }).catch(() => {})}
            />
          </Row>
          <div className="space-y-1.5 px-3 pb-3 pt-1">
            <div className="label-mono">{t('backup_list')}</div>
            {snapshots ? <BackupList snapshots={snapshots} request={api.request} /> : null}
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive px-3 pb-3 text-[11.5px]">
          {error}
        </p>
      )}
    </div>
  );
}
