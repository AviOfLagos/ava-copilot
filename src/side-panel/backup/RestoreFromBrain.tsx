import { useCallback, useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import type { BackupMeta } from '@src/shared/lib/protocol/companion';
import { Button } from '../components/ui/button';
import type { ModelsRequest } from '../models/useProviders';
import { BackupList } from './BackupList';

/**
 * The first-run restore, for a reinstall: find Nex Brain on this Mac, pair (on its own, or with the code it prints), pick a
 * backup and put it back. The extension then starts again with everything restored, so the rest of the
 * setup is not shown (the restored settings say it was done).
 */

type Phase = 'checking' | 'unreachable' | 'pair' | 'list';

const inputClass =
  'w-full min-w-0 rounded-lg border bg-card px-3 py-2 text-[15px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50';

export default function RestoreFromBrain({ request, onCancel }: { request: ModelsRequest; onCancel: () => void }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<BackupMeta[]>([]);

  const list = useCallback(async () => {
    const reply = await request<{ snapshots: BackupMeta[] }>({ type: 'backup_list' }, 20_000);
    setSnapshots(reply.snapshots);
    setPhase('list');
  }, [request]);

  const check = useCallback(async () => {
    setPhase('checking');
    setError(null);
    try {
      const { reachable, paired } = await request<{ reachable: boolean; paired: boolean }>(
        { type: 'backup_probe' },
        10_000,
      );
      if (!reachable) setPhase('unreachable');
      else if (paired) await list();
      else {
        // Nex Brain allows Nex Copilot to pair with no code unless the Mac turned that off; then the code is asked
        const auto = await request({ type: 'brain_auto_pair' }, 20_000).then(
          () => true,
          () => false,
        );
        if (auto) await list();
        else setPhase('pair');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPhase('unreachable');
    }
  }, [request, list]);

  // Once, when it opens: the panel's request changes identity on every render, and checking again would drop
  // the list (and a restore's "Restored") while the setup re-renders around it
  useEffect(() => {
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pair = async () => {
    setBusy(true);
    setError(null);
    try {
      await request({ type: 'brain_pair', code }, 20_000);
      await list();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="restore-from-brain">
      {phase === 'checking' && (
        <p role="status" className="text-muted-foreground text-[13px]">
          {t('backup_onboard_checking')}
        </p>
      )}

      {phase === 'unreachable' && (
        <>
          <p className="text-muted-foreground text-[13px] leading-relaxed">{t('backup_onboard_unreachable')}</p>
          <Button variant="glass" className="self-start" onClick={() => void check()}>
            {t('backup_onboard_retry')}
          </Button>
        </>
      )}

      {phase === 'pair' && (
        <form
          className="flex flex-col gap-2"
          onSubmit={event => {
            event.preventDefault();
            void pair();
          }}>
          <p className="text-muted-foreground text-[13px] leading-relaxed">{t('brain_pair_hint')}</p>
          <label htmlFor="restore-code" className="label-mono">
            {t('brain_code_label')}
          </label>
          <input
            id="restore-code"
            data-autofocus
            className={cn(inputClass, 'font-mono uppercase tracking-wider')}
            value={code}
            placeholder="ABCD-2345"
            autoComplete="off"
            spellCheck={false}
            onChange={event => setCode(event.target.value.slice(0, 12))}
          />
          <Button type="submit" className="self-start" disabled={busy || code.trim().length < 8}>
            {busy ? t('brain_pairing') : t('brain_pair')}
          </Button>
        </form>
      )}

      {phase === 'list' && (
        <>
          <p className="text-muted-foreground text-[13px] leading-relaxed">
            {snapshots.length ? t('backup_onboard_choose') : t('backup_onboard_none')}
          </p>
          {snapshots.length > 0 && <BackupList snapshots={snapshots} request={request} />}
        </>
      )}

      {error && (
        <p role="alert" className="text-destructive text-[11.5px]">
          {error}
        </p>
      )}

      <Button variant="ghost" className="self-start" onClick={onCancel}>
        {t('backup_onboard_back')}
      </Button>
    </div>
  );
}
