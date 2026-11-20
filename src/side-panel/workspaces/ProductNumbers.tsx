import { useCallback, useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { maskKey } from '@extension/storage';
import { Button } from '../components/ui/button';

/**
 * A product's numbers, in the workspace editor: whether Ava can read them and, if not, why; the token of the
 * product's API (kept in the vault, shown only as its last characters); and "Read now". A number that could not
 * be read shows as "no reading", never as 0.
 */

const field =
  'glass w-full rounded-xl px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50';

interface Status {
  hasApi: boolean;
  hasToken: boolean;
  tokenTail: string;
  status: 'connected' | 'not_connected' | null;
  reason: string | null;
  reasonText: string;
  checkedAt: number | null;
  lastOkAt: number | null;
  signupsToday: number | null;
}

/** Asks the background, the only reader of the vault and writer of the numbers. */
async function ask(message: Record<string, unknown>): Promise<Status> {
  const reply = (await chrome.runtime.sendMessage({ ...message, requestId: crypto.randomUUID() })) as
    { type: 'growth_ok'; result: Status } | { type: 'error'; error: string } | undefined;
  if (!reply || reply.type !== 'growth_ok') throw new Error(reply?.type === 'error' ? reply.error : 'No answer');
  return reply.result;
}

const clock = (at: number) =>
  new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function ProductNumbers({ workspaceId, hasApi }: { workspaceId: string; hasApi: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = useCallback(async (message: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      setStatus(await ask(message));
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run({ type: 'growth_status', workspaceId });
  }, [run, workspaceId]);

  const line = !status
    ? ''
    : status.status === 'not_connected'
      ? t('growth_notConnected', [status.reasonText])
      : status.status === 'connected'
        ? status.reason
          ? t('growth_connectedBut', [status.reasonText])
          : t('growth_connected', [status.lastOkAt ? clock(status.lastOkAt) : ''])
        : t('growth_never');

  return (
    <fieldset className="flex flex-col gap-2" data-testid="product-numbers">
      <legend className="text-muted-foreground mb-1 text-[12px]">{t('growth_title')}</legend>
      <p className="text-muted-foreground text-[11.5px] leading-snug">{t('growth_hint')}</p>
      {!hasApi ? (
        <p className="text-[12px]">{t('growth_noApi')}</p>
      ) : (
        <>
          <p className="text-[12px] leading-snug" role="status" data-testid="numbers-status">
            {busy ? t('growth_reading') : line}
          </p>
          {status && (
            <p className="text-muted-foreground text-[11.5px]" data-testid="numbers-signups">
              {t('growth_signupsToday', [
                status.signupsToday === null ? t('growth_noReading') : String(status.signupsToday),
              ])}
            </p>
          )}
          <label className="flex flex-col gap-1 text-[12px]">
            <span className="text-muted-foreground">
              {t('growth_token')}
              {status?.hasToken ? ` · ${t('growth_token_saved', [maskKey(status.tokenTail)])}` : ''}
            </span>
            <input
              type="password"
              autoComplete="off"
              value={token}
              placeholder={t('growth_token_placeholder')}
              onChange={event => setToken(event.target.value)}
              className={field}
            />
          </label>
          {error && (
            <p role="alert" className="text-destructive text-[11.5px]">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy || !token.trim()}
              onClick={async () => {
                await run({ type: 'growth_set_token', workspaceId, token });
                setToken('');
              }}>
              {t('growth_token_save')}
            </Button>
            {status?.hasToken && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void run({ type: 'growth_set_token', workspaceId, token: '' })}>
                {t('growth_token_remove')}
              </Button>
            )}
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void run({ type: 'growth_collect', workspaceId })}>
              {t('growth_readNow')}
            </Button>
          </div>
        </>
      )}
    </fieldset>
  );
}
