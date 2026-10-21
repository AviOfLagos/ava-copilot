import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { obsidianSyncStore } from '@extension/storage';
import type { ObsidianSyncState, ObsidianVaultSetting } from '@extension/storage';
import type { ObsidianVault } from '@src/shared/lib/protocol/companion';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { askBackground, typedVaultPath, vaultChoices } from './brain';

const row = 'flex items-center gap-3 px-3 py-2.5';
const hint = 'text-muted-foreground mt-0.5 text-[11.5px]';

function Result({ result }: { result: { text: string; alert: boolean } | null }) {
  if (!result) return null;
  return (
    <div
      role={result.alert ? 'alert' : 'status'}
      className={result.alert ? 'text-destructive mt-0.5 text-[11.5px]' : hint}>
      {result.text}
    </div>
  );
}

/** Settings › Obsidian with Nex Brain paired and no vault chosen: the vaults it found, and a folder to type. */
export function BrainVaultPicker() {
  const [vaults, setVaults] = useState<ObsidianVault[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; alert: boolean } | null>(null);

  useEffect(() => {
    askBackground<{ vaults: ObsidianVault[] }>('obsidian_vaults').then(
      reply => setVaults(vaultChoices(reply.vaults)),
      error => {
        setVaults([]);
        setProblem(error instanceof Error ? error.message : String(error));
      },
    );
  }, []);

  const use = async (path: string) => {
    setBusy(path);
    setResult(null);
    try {
      await askBackground('obsidian_use', { path });
    } catch (error) {
      setResult({ text: error instanceof Error ? error.message : String(error), alert: true });
    } finally {
      setBusy(null);
    }
  };

  const typedPath = typedVaultPath(typed);
  return (
    <div data-vault="brain-pick">
      <div className="px-3 pt-2.5">
        <div className="text-[13px]">{t('vault_brain_title')}</div>
        <div className={hint}>{t('vault_brain_hint')}</div>
      </div>
      <div className="px-3 pt-2 text-[11.5px] font-medium">{t('vault_brain_found')}</div>
      {vaults === null ? (
        <p className={`${hint} px-3 pb-1`}>{t('vault_brain_looking')}</p>
      ) : vaults.length === 0 ? (
        <p className={`${hint} px-3 pb-1`} role={problem ? 'alert' : undefined}>
          {problem ?? t('vault_brain_none')}
        </p>
      ) : (
        <ul aria-label={t('vault_brain_found')}>
          {vaults.map(vault => (
            <li key={vault.id} className={row} data-vault-choice={vault.name}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">{vault.name}</div>
                <div className={`${hint} truncate font-mono`} title={vault.path}>
                  {vault.usable ? vault.path : t('vault_brain_missing')}
                </div>
              </div>
              <Button
                size="sm"
                disabled={!vault.usable || busy !== null}
                aria-label={t('vault_brain_useNamed', [vault.name])}
                onClick={() => void use(vault.path)}>
                {busy === vault.path ? t('vault_syncing') : t('vault_brain_use')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-1.5 px-3 pb-2.5 pt-1">
        <label htmlFor="vault-brain-path" className="block text-[11.5px] font-medium">
          {t('vault_brain_other')}
        </label>
        <div className="flex gap-2">
          <input
            id="vault-brain-path"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="~/Documents/My Vault"
            value={typed}
            onChange={event => setTyped(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && typedPath) void use(typedPath);
            }}
            className="min-w-0 flex-1 rounded-xl border bg-transparent px-2.5 py-1.5 font-mono text-[11.5px] text-foreground outline-none focus:border-primary/50"
          />
          <Button
            size="sm"
            variant="glass"
            disabled={!typedPath || busy !== null}
            onClick={() => typedPath && void use(typedPath)}>
            {t('vault_brain_use')}
          </Button>
        </div>
        <div className={hint}>{t('vault_brain_other_hint')}</div>
        <Result result={result} />
      </div>
    </div>
  );
}

/** Settings › Obsidian with the vault on the Mac: how the last sync went, sync now, notes in, and letting go. */
export function BrainVaultConnected({ setting }: { setting: ObsidianVaultSetting }) {
  const [sync, setSync] = useState<ObsidianSyncState | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; alert: boolean } | null>(null);

  useEffect(() => {
    const read = () => void obsidianSyncStore.getState().then(setSync);
    read();
    return obsidianSyncStore.subscribe(read);
  }, []);

  const run = async (type: string, body: Record<string, unknown> = {}) => {
    setBusy(true);
    setResult(null);
    try {
      const reply = await askBackground<{ written?: number; read?: number }>(type, body);
      if (type === 'obsidian_sync') {
        setResult({ text: t('vault_synced', [String(reply.written ?? 0), String(reply.read ?? 0)]), alert: false });
      }
    } catch (error) {
      setResult({ text: error instanceof Error ? error.message : String(error), alert: true });
    } finally {
      setBusy(false);
    }
  };

  const last = sync?.lastError
    ? { text: t('vault_brain_lastError', [sync.lastError]), alert: true }
    : sync?.lastCounts
      ? { text: t('vault_synced', [String(sync.lastCounts.written), String(sync.lastCounts.read)]), alert: false }
      : null;
  return (
    <div data-vault="brain">
      <div className={row}>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px]">{setting.name}</div>
          <div className={`${hint} truncate font-mono`} title={setting.path ?? ''}>
            {setting.path}
          </div>
          <div className={hint}>{t('vault_brain_on')}</div>
          <Result result={result ?? last} />
        </div>
        <Button size="sm" variant="glass" disabled={busy} onClick={() => void run('obsidian_sync')}>
          {busy ? t('vault_syncing') : t('vault_syncNow')}
        </Button>
      </div>
      <div className={row}>
        <div className="min-w-0 flex-1">
          <div className="text-[13px]">{t('vault_readNotes')}</div>
          <div className={hint}>{t('vault_readNotes_hint')}</div>
        </div>
        <Switch
          label={t('vault_readNotes')}
          checked={setting.readNotes}
          onChange={value => void run('obsidian_read_notes', { on: value })}
        />
      </div>
      <div className={row}>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run('obsidian_disconnect')}>
          {t('vault_disconnect')}
        </Button>
      </div>
    </div>
  );
}
