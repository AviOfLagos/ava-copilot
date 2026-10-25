import { useCallback, useEffect, useMemo, useState } from 'react';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import { brainSettingsStore } from '@src/background/companion/state';
import type { BrainSettings } from '@src/background/companion/state';
import { DEFAULT_WHATSAPP_REMOTE_SETTINGS } from '@src/background/whatsapp-remote/state';
import type { WhatsAppRemoteSettings } from '@src/background/whatsapp-remote/state';
import type { NoticeKind } from '@src/background/notices';
import { WHATSAPP_NUMBER } from '@src/shared/lib/protocol/companion';
import type { WhatsAppStatus } from '@src/shared/lib/protocol/companion';
import { settingsPageUrl } from '@src/shared/lib/settings-page';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import type { PanelApi } from '../registry';
import { encodeQr, qrPath } from './qr';

/**
 * Settings › Connections › WhatsApp (Ava messages you): link Ava Brain's own WhatsApp Web session by scanning a
 * code under Linked devices, see whether it is linked, choose what Ava messages you about and when she keeps
 * quiet, and unlink. Ava only ever talks to you there. The background and Ava Brain do the work; this page sends
 * commands and shows the replies (the code to scan is only ever in a reply, never stored).
 */

const row = 'flex flex-col gap-1.5 px-3 py-2.5';
const inputClass =
  'w-full min-w-0 rounded-lg border bg-card px-2 py-1 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50';
const DATA_URL_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

type Reply = { status: WhatsAppStatus; settings: WhatsAppRemoteSettings };
type Busy = 'link' | 'unlink' | 'owner' | 'test' | 'connect' | 'restart' | null;

const KINDS: { kind: NoticeKind; label: Parameters<typeof t>[0] }[] = [
  { kind: 'approval', label: 'wava_settings_notify_approval' },
  { kind: 'meeting', label: 'wava_settings_notify_meeting' },
  { kind: 'brief', label: 'wava_settings_notify_brief' },
  { kind: 'routine', label: 'wava_settings_notify_routine' },
];

function LinkCode({ code }: { code: string }) {
  const path = useMemo(() => {
    if (DATA_URL_IMAGE.test(code)) return null;
    try {
      const modules = encodeQr(code);
      return { d: qrPath(modules), size: modules.length + 8 };
    } catch {
      return null;
    }
  }, [code]);
  const label = t('wava_settings_qr_label');
  return (
    <div className="flex justify-center py-1">
      {path ? (
        <svg
          role="img"
          aria-label={label}
          viewBox={`0 0 ${path.size} ${path.size}`}
          className="size-56 rounded-lg bg-white"
          shapeRendering="crispEdges">
          <path d={path.d} fill="#000" />
        </svg>
      ) : DATA_URL_IMAGE.test(code) ? (
        <img src={code} alt={label} className="size-56 rounded-lg bg-white" />
      ) : null}
    </div>
  );
}

const formatNumber = (number: string | null) => (number ? `+${number}` : '');

/** "just now", "5 min ago", "3 h ago", "2 d ago": when something last happened, in the browser's language. */
function ago(at: number | null, now = Date.now()): string | null {
  if (!at) return null;
  const minutes = Math.round((now - at) / 60_000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
  if (minutes < 1) return format.format(0, 'minute');
  if (minutes < 60) return format.format(-minutes, 'minute');
  if (minutes < 48 * 60) return format.format(-Math.round(minutes / 60), 'hour');
  return format.format(-Math.round(minutes / 1440), 'day');
}

export default function WhatsAppSettings({ api }: { api: PanelApi }) {
  const [brain, setBrain] = useState<BrainSettings | null>(null);
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [settings, setSettings] = useState<WhatsAppRemoteSettings>(DEFAULT_WHATSAPP_REMOTE_SETTINGS);
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const load = () => void brainSettingsStore.getSettings().then(setBrain);
    load();
    return brainSettingsStore.subscribe(load);
  }, []);

  const apply = useCallback((reply: Partial<Reply>) => {
    if (reply.status) {
      setStatus(reply.status);
      setOwner(current => current || reply.status!.ownerNumber || '');
    }
    if (reply.settings) setSettings(reply.settings);
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await api.request<Reply>({ type: 'wava_status' }, 10_000));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [api, apply]);

  // Asks when the page opens, and every two seconds while a code is on its way or waiting to be scanned, or while
  // the connect code waits for his message
  const linking = status?.state === 'starting' || status?.state === 'scan' || Boolean(status?.connectCode);
  useEffect(() => {
    if (!brain?.paired) return;
    void refresh();
    if (!linking) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [brain?.paired, linking, refresh]);

  const run = useCallback(
    async (kind: Exclude<Busy, null>, message: Record<string, unknown>, done?: string) => {
      setBusy(kind);
      setError(null);
      setNotice(null);
      try {
        apply(await api.request<Partial<Reply>>(message, 35_000));
        if (done) setNotice(done);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(null);
      }
    },
    [api, apply],
  );

  const save = (changes: Partial<WhatsAppRemoteSettings>) => {
    setSettings(current => ({ ...current, ...changes, notify: { ...current.notify, ...changes.notify } }));
    void api
      .request<Partial<Reply>>({ type: 'wava_settings', ...changes })
      .then(apply)
      .catch(caught => setError(caught instanceof Error ? caught.message : String(caught)));
  };

  if (!brain) return null;
  if (!brain.paired) {
    return (
      <div className={row}>
        <p className="text-[13px]">{t('wava_settings_needsBrain')}</p>
        <a className="text-primary text-[12.5px] underline" href={settingsPageUrl('#connections/brain')}>
          {t('wava_settings_openBrain')}
        </a>
      </div>
    );
  }

  const state = status?.state ?? null;
  const ownerValid = owner === '' || WHATSAPP_NUMBER.test(owner);
  const stateLine =
    state === 'linked'
      ? status!.number
        ? t('wava_state_linked', [formatNumber(status!.number)])
        : t('wava_state_linkedPlain')
      : state === 'scan'
        ? t('wava_state_scan')
        : state === 'starting'
          ? t('wava_state_starting')
          : state === 'disconnected'
            ? t('wava_state_disconnected')
            : state === 'failed'
              ? t('wava_state_failed')
              : state === 'not_linked'
                ? t('wava_state_notLinked')
                : t('wava_state_unknown');

  return (
    <>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span
          aria-hidden="true"
          className={cn(
            'inline-block size-2 shrink-0 rounded-full',
            state === 'linked' ? 'bg-primary shadow-[0_0_8px_rgb(var(--primary-rgb))]' : 'bg-muted-foreground/50',
            (state === 'failed' || state === 'disconnected') && 'bg-destructive',
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[13px]" role="status" aria-live="polite">
            {stateLine}
          </p>
          {status?.message ? <p className="text-muted-foreground text-[11.5px]">{status.message}</p> : null}
        </div>
        {state === 'linked' ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              if (window.confirm(t('wava_settings_logout_confirm'))) void run('unlink', { type: 'wava_unlink' });
            }}>
            {t('wava_settings_unlink')}
          </Button>
        ) : state === 'starting' || state === 'scan' ? null : (
          <Button
            size="sm"
            disabled={busy !== null || state === null}
            onClick={() => void run('link', { type: 'wava_link' })}>
            {busy === 'link'
              ? t('wava_settings_linking')
              : state === 'disconnected' || state === 'failed'
                ? t('wava_settings_relink')
                : t('wava_settings_link')}
          </Button>
        )}
      </div>

      {state === 'scan' && status?.qr ? (
        <div className={row}>
          <LinkCode code={status.qr} />
          <p className="text-muted-foreground text-[11.5px]">{t('wava_settings_scanHint')}</p>
        </div>
      ) : null}

      {state === 'not_linked' ? (
        <p className="text-muted-foreground px-3 py-2 text-[11.5px]">{t('wava_settings_intro')}</p>
      ) : null}

      {state === 'linked' ? (
        <>
          <div className={row}>
            <p className="text-muted-foreground text-[11.5px]">
              {status?.ownerNumber
                ? t('wava_settings_talksTo_owner', [formatNumber(status.ownerNumber)])
                : t('wava_settings_talksTo_self')}
            </p>
            {status?.lastInAt || status?.lastOutAt ? (
              <p className="text-muted-foreground text-[11.5px]" data-wava-activity>
                {[
                  status.lastInAt ? t('wava_settings_lastIn', [ago(status.lastInAt)!]) : null,
                  status.lastOutAt ? t('wava_settings_lastOut', [ago(status.lastOutAt)!]) : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
              </p>
            ) : null}
            <Button
              variant="glass"
              size="sm"
              disabled={busy !== null}
              onClick={() => void run('test', { type: 'wava_test' }, t('wava_settings_testSent'))}>
              {t('wava_settings_test')}
            </Button>
          </div>

          <div className={row} data-wava-phone={status?.phoneConnected ? 'connected' : 'not-connected'}>
            <div className="text-[12.5px] font-medium">{t('wava_settings_phone_title')}</div>
            {status?.phoneConnected ? (
              <p className="text-muted-foreground text-[11.5px]">{t('wava_settings_phone_connected')}</p>
            ) : status?.connectCode ? (
              <>
                <p className="text-[11.5px]">{t('wava_settings_phone_send')}</p>
                <p className="bg-card self-start rounded-lg border px-3 py-1.5 font-mono text-[15px] tracking-wider select-all">
                  {status.connectCode}
                </p>
                <p className="text-muted-foreground text-[11.5px]" role="status" aria-live="polite">
                  {t('wava_settings_phone_waiting')}
                </p>
              </>
            ) : (
              <>
                <p
                  className={cn(
                    'text-[11.5px]',
                    status?.needsFirstMessage ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
                  )}>
                  {status?.needsFirstMessage ? t('wava_settings_firstMessage') : t('wava_settings_phone_hint')}
                </p>
                <Button
                  variant="glass"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void run('connect', { type: 'wava_connect' })}>
                  {t('wava_settings_phone_connect')}
                </Button>
              </>
            )}
          </div>

          <form
            className={row}
            onSubmit={event => {
              event.preventDefault();
              if (ownerValid) void run('owner', { type: 'wava_owner', number: owner || null });
            }}>
            <label className="flex flex-col gap-1 text-[11.5px]">
              {t('wava_settings_owner_label')}
              <input
                className={cn(inputClass, 'font-mono')}
                inputMode="numeric"
                value={owner}
                placeholder="2348012345678"
                onChange={event => setOwner(event.target.value.replace(/[^0-9]/g, '').slice(0, 15))}
                aria-invalid={!ownerValid}
              />
            </label>
            <p className="text-muted-foreground text-[11px]">{t('wava_settings_owner_hint')}</p>
            <Button type="submit" variant="glass" size="sm" disabled={busy !== null || !ownerValid}>
              {t('wava_settings_owner_save')}
            </Button>
          </form>
        </>
      ) : null}

      <div className={row}>
        <p className="text-[13px]">{t('wava_settings_notify_title')}</p>
        {KINDS.map(({ kind, label }) => (
          <div key={kind} className="flex items-center justify-between gap-3 text-[12.5px]">
            <span>{t(label)}</span>
            <Switch
              checked={settings.notify[kind]}
              label={t(label)}
              onChange={checked => save({ notify: { ...settings.notify, [kind]: checked } })}
            />
          </div>
        ))}
        <div className="flex items-center gap-2 pt-1 text-[12px]">
          <label className="flex items-center gap-1.5">
            {t('wava_settings_quiet_from')}
            <input
              type="time"
              className={cn(inputClass, 'w-24')}
              value={settings.quietStart}
              onChange={event => event.target.value && save({ quietStart: event.target.value })}
            />
          </label>
          <label className="flex items-center gap-1.5">
            {t('wava_settings_quiet_to')}
            <input
              type="time"
              className={cn(inputClass, 'w-24')}
              value={settings.quietEnd}
              onChange={event => event.target.value && save({ quietEnd: event.target.value })}
            />
          </label>
        </div>
        <p className="text-muted-foreground text-[11px]">{t('wava_settings_quiet_hint')}</p>
      </div>

      {state === 'linked' || state === 'disconnected' ? (
        <div className="flex items-center justify-between gap-3 px-3 py-2.5" data-wava-manage>
          <p className="text-muted-foreground text-[11.5px]">{t('wava_settings_restart_hint')}</p>
          <Button
            variant="glass"
            size="sm"
            disabled={busy !== null}
            onClick={() => void run('restart', { type: 'wava_restart' }, t('wava_settings_restarted'))}>
            {busy === 'restart' ? t('wava_settings_restarting') : t('wava_settings_restart')}
          </Button>
        </div>
      ) : null}

      <p className="text-muted-foreground px-3 py-2 text-[11px]">
        {t('wava_settings_risk', [String(status?.sendLimitPerHour ?? 20)])}
      </p>

      {notice ? (
        <p role="status" className="px-3 py-2 text-[12px]">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive px-3 py-2 text-[12px]">
          {error}
        </p>
      ) : null}
    </>
  );
}
