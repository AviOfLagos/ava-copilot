import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import type { BackupMeta } from '@src/shared/lib/protocol/companion';
import { Button } from '../components/ui/button';
import type { ModelsRequest } from '../models/useProviders';

/** Shared by Settings › Memory › Backups and the first-run restore: the list, and the click that restores. */

export const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export function describeCounts(counts: Record<string, number>): string {
  return t('backup_counts', [String(counts.threads ?? 0), String(counts.meetings ?? 0), String(counts.kbItems ?? 0)]);
}

/** A restore ends with the extension starting again; until then this says so. */
export function useRestore(request: ModelsRequest) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restore = async (message: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await request(message, 10 * 60_000);
      setDone(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  return { busy, done, error, restore };
}

/** "Replace everything here?" with the click that does it, and a way out. */
export function RestoreConfirm({
  question,
  busy,
  onConfirm,
  onCancel,
}: {
  question: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Esc is the way out, as on every card that asks
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [busy, onCancel]);
  return (
    <div role="alertdialog" aria-label={t('backup_restore')} className="glass space-y-2 rounded-xl p-2.5">
      <p className="text-[12px] leading-snug">{question}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          {t('backup_cancel')}
        </Button>
        <Button size="sm" variant="hold" onClick={onConfirm} disabled={busy} data-testid="backup-confirm">
          {busy ? t('backup_restoring') : t('backup_restore_confirm_button')}
        </Button>
      </div>
    </div>
  );
}

export function BackupList({ snapshots, request }: { snapshots: BackupMeta[]; request: ModelsRequest }) {
  const [asking, setAsking] = useState<string | null>(null);
  const { busy, done, error, restore } = useRestore(request);

  if (done) {
    return (
      <p role="status" className="text-[12.5px]">
        {t('backup_restored')}
      </p>
    );
  }
  if (!snapshots.length) return <p className="text-muted-foreground text-[11.5px]">{t('backup_list_empty')}</p>;

  return (
    <div className="space-y-1.5">
      <ul className="space-y-1.5" aria-label={t('backup_list')}>
        {snapshots.map(snapshot => (
          <li key={snapshot.id} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px]">{when(snapshot.createdAt)}</div>
                <div className="text-muted-foreground text-[11px]">
                  {describeCounts(snapshot.counts)} · {megabytes(snapshot.bytes)}
                </div>
              </div>
              <Button
                size="sm"
                variant="glass"
                disabled={busy}
                aria-label={`${t('backup_restore')} ${when(snapshot.createdAt)}`}
                onClick={() => setAsking(snapshot.id)}>
                {t('backup_restore')}
              </Button>
            </div>
            {asking === snapshot.id && (
              <RestoreConfirm
                question={t('backup_restore_confirm', [when(snapshot.createdAt)])}
                busy={busy}
                onCancel={() => setAsking(null)}
                onConfirm={() => void restore({ type: 'backup_restore', snapshotId: snapshot.id, confirmed: true })}
              />
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-destructive text-[11.5px]">
          {error}
        </p>
      )}
    </div>
  );
}
