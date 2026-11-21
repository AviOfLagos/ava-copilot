import { useCallback, useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { Button } from '../components/ui/button';

/**
 * Settings › General › Rounds and check-ins: whether Ava does her rounds, what ran today, and "Run now" for each.
 * A round's digest lands in the Inbox; nothing a round does sends, posts or changes anything.
 */

type RoundId = 'pulse' | 'mail' | 'stuck';

interface Status {
  enabled: boolean;
  rounds: { id: RoundId; times: { time: string; ranAt: number | null }[] }[];
  offersToday: number;
  offersLeft: number;
  silenced: boolean;
}

const NAMES: Record<RoundId, () => string> = {
  pulse: () => t('rounds_name_pulse'),
  mail: () => t('rounds_name_mail'),
  stuck: () => t('rounds_name_stuck'),
};

async function ask(message: Record<string, unknown>): Promise<Status> {
  const reply = (await chrome.runtime.sendMessage({ ...message, requestId: crypto.randomUUID() })) as
    { type: 'rounds_ok'; result: Status } | { type: 'error'; error: string } | undefined;
  if (!reply || reply.type !== 'rounds_ok') throw new Error(reply?.type === 'error' ? reply.error : 'No answer');
  return reply.result;
}

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export default function RoundsSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const run = useCallback(async (what: string, message: Record<string, unknown>) => {
    setBusy(what);
    setError('');
    try {
      setStatus(await ask(message));
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void run('load', { type: 'rounds_status' });
  }, [run]);

  if (!status) return <p className="text-muted-foreground px-3 py-2.5 text-[12px]">{error || t('growth_reading')}</p>;

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5" data-testid="rounds-settings">
      <label className="flex items-center justify-between gap-3 text-[13px]">
        <span>
          {t('rounds_toggle')}
          <span className="text-muted-foreground block text-[11.5px] leading-snug">{t('rounds_toggle_hint')}</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-checked={status.enabled}
          checked={status.enabled}
          disabled={busy !== null}
          onChange={event => void run('toggle', { type: 'rounds_set_enabled', enabled: event.target.checked })}
        />
      </label>
      <ul className="flex flex-col gap-1.5">
        {status.rounds.map(round => (
          <li key={round.id} className="flex items-center gap-2 text-[12.5px]" data-testid={`round-${round.id}`}>
            <span className="min-w-0 flex-1">
              {NAMES[round.id]()}
              <span className="text-muted-foreground block text-[11.5px]">
                {round.times
                  .map(slot =>
                    slot.ranAt === null
                      ? slot.time
                      : slot.ranAt === 0
                        ? t('rounds_slot_skipped', [slot.time])
                        : t('rounds_slot_ran', [slot.time, clock(slot.ranAt)]),
                  )
                  .join(' · ')}
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              aria-label={t('rounds_runNow_named', [NAMES[round.id]()])}
              onClick={() => void run(round.id, { type: 'rounds_run', round: round.id })}>
              {busy === round.id ? t('growth_reading') : t('rounds_runNow')}
            </Button>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-[11.5px] leading-snug" data-testid="rounds-offers">
        {status.silenced
          ? t('rounds_offers_silenced')
          : t('rounds_offers', [String(status.offersToday), String(status.offersLeft)])}
      </p>
      {error && (
        <p role="alert" className="text-destructive text-[11.5px]">
          {error}
        </p>
      )}
    </div>
  );
}
