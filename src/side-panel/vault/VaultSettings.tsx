import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { t } from '@extension/i18n';
import { VAULT_STATE_KEY } from '@extension/storage';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import {
  allowVault,
  BRAVE_FLAG_URL,
  connectVault,
  disconnectVault,
  setReadNotes,
  syncVault,
  vaultStatus,
  vaultSupport,
  VaultUnsupported,
} from './vault';
import type { VaultStatus } from './vault';

/** What went wrong, in words the user can act on. Closing the picker is not worth showing. */
function problemText(error: unknown): string | null {
  if (error instanceof DOMException && error.name === 'AbortError') return null;
  if (error instanceof VaultUnsupported) return null;
  if (error instanceof DOMException && (error.name === 'SecurityError' || error.name === 'NotAllowedError')) {
    return t('vault_error_notAllowed');
  }
  return t('vault_error_generic', [error instanceof Error ? error.message : String(error)]);
}

/** Brave keeps the folder picker off: the steps to turn it on, with the setting one click away. */
function BraveSteps() {
  return (
    <div className="px-3 py-2.5" data-vault-brave>
      <div className="text-[13px]">{t('vault_brave_title')}</div>
      <ol className="text-muted-foreground mt-1 list-decimal space-y-0.5 pl-4 text-[11.5px]">
        <li>{t('vault_brave_step1')}</li>
        <li>{t('vault_brave_step2')}</li>
        <li>{t('vault_brave_step3')}</li>
      </ol>
      <Button
        size="sm"
        variant="hold"
        className="mt-2"
        onClick={() => void chrome.tabs.create({ url: BRAVE_FLAG_URL }).catch(() => {})}>
        <ExternalLink className="size-3.5" aria-hidden />
        {t('vault_brave_open')}
      </Button>
    </div>
  );
}

/** Settings › Obsidian: pick the vault, allow access again after a restart, sync now, or let go of it. */
export default function VaultSettings() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; alert: boolean } | null>(null);
  const support = vaultSupport();

  const refresh = () => void vaultStatus().then(setStatus);
  useEffect(() => {
    refresh();
    // Another view of the vault (the guided setup, Settings) connected or let go of it
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[VAULT_STATE_KEY]) refresh();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setResult(null);
    try {
      await work();
      const { written, read } = await syncVault();
      setResult({ text: t('vault_synced', [String(written), String(read)]), alert: false });
    } catch (error) {
      const text = problemText(error);
      if (text) setResult({ text, alert: true });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (!status) return null;
  const row = 'flex items-center gap-3 px-3 py-2.5';
  const resultLine = result && (
    <div
      role={result.alert ? 'alert' : 'status'}
      className={result.alert ? 'text-destructive mt-0.5 text-[11.5px]' : 'text-muted-foreground mt-0.5 text-[11.5px]'}>
      {result.text}
    </div>
  );

  if (!status.name) {
    return (
      <div data-vault="none">
        <div className={row}>
          <div className="min-w-0 flex-1">
            <div className="text-[13px]">{t('vault_connect_title')}</div>
            <div className="text-muted-foreground mt-0.5 text-[11.5px]">{t('vault_connect_hint')}</div>
            {resultLine}
          </div>
          {support === 'ok' && (
            <Button size="sm" disabled={busy} onClick={() => void run(connectVault)}>
              {t('vault_connect')}
            </Button>
          )}
        </div>
        {support === 'brave_off' && <BraveSteps />}
        {support === 'unsupported' && (
          <p className="text-muted-foreground px-3 pb-2.5 text-[11.5px]">{t('vault_unsupported')}</p>
        )}
      </div>
    );
  }

  return (
    <div data-vault={status.access === 'granted' ? 'on' : 'needs-access'}>
      <div className={row}>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px]">{status.name}</div>
          {resultLine ?? (
            <div className="text-muted-foreground mt-0.5 text-[11.5px]">
              {status.access === 'granted' ? t('vault_on') : t('vault_needsAccess')}
            </div>
          )}
        </div>
        {status.access === 'granted' ? (
          <Button size="sm" variant="glass" disabled={busy} onClick={() => void run(async () => {})}>
            {busy ? t('vault_syncing') : t('vault_syncNow')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="hold"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (!(await allowVault())) throw new DOMException('Access was not allowed.', 'NotAllowedError');
              })
            }>
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
    </div>
  );
}
