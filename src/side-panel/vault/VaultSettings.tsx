import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { allowVault, connectVault, disconnectVault, setReadNotes, syncVault, vaultStatus } from './vault';
import type { VaultStatus } from './vault';

/** Settings › Obsidian: pick the vault, allow access again after a restart, sync now, or let go of it. */
export default function VaultSettings() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');

  const refresh = () => void vaultStatus().then(setStatus);
  useEffect(refresh, []);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setResult('');
    try {
      await work();
      const { written, read } = await syncVault();
      setResult(t('vault_synced', [String(written), String(read)]));
    } catch (error) {
      // Closing the folder picker is not an error worth showing
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setResult(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (!status) return null;
  const row = 'flex items-center gap-3 px-3 py-2.5';

  if (!status.name) {
    return (
      <div className={row}>
        <div className="min-w-0 flex-1">
          <div className="text-[13px]">{t('vault_connect_title')}</div>
          <div className="text-muted-foreground mt-0.5 text-[11.5px]">{t('vault_connect_hint')}</div>
        </div>
        <Button size="sm" disabled={busy} onClick={() => void run(connectVault)}>
          {t('vault_connect')}
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className={row}>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px]">{status.name}</div>
          <div className="text-muted-foreground mt-0.5 text-[11.5px]">
            {result || (status.access === 'granted' ? t('vault_on') : t('vault_needsAccess'))}
          </div>
        </div>
        {status.access === 'granted' ? (
          <Button size="sm" variant="glass" disabled={busy} onClick={() => void run(async () => {})}>
            {busy ? t('vault_syncing') : t('vault_syncNow')}
          </Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => void run(allowVault)}>
            {t('vault_allow')}
          </Button>
        )}
      </div>
      <div className={row}>
        <div className="min-w-0 flex-1">
          <div className="text-[13px]">{t('vault_readNotes')}</div>
          <div className="text-muted-foreground mt-0.5 text-[11.5px]">{t('vault_readNotes_hint')}</div>
        </div>
        <Switch
          label={t('vault_readNotes')}
          checked={status.readNotes}
          onChange={value => void setReadNotes(value).then(refresh)}
        />
      </div>
      <div className={row}>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => void disconnectVault().then(refresh)}>
          {t('vault_disconnect')}
        </Button>
      </div>
    </>
  );
}
