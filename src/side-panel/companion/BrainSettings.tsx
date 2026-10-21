import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import { brainSettingsStore, brainStatusStore } from '@src/background/companion/state';
import type { BrainSettings as BrainSettingsValue, BrainStatus } from '@src/background/companion/state';
import type { Artifact } from '@src/shared/lib/protocol/companion';
import { Button } from '../components/ui/button';
import type { PanelApi } from '../registry';

/**
 * Settings › Nex Brain: pair this browser with the companion on the Mac (a one-time code from
 * `avi-brain pair`), see whether it runs and whether Docker does, and open what agents made in an Avi
 * Studio tab. The background does all the talking; this page sends commands and reads the stored status.
 */

const row = 'flex flex-col gap-1.5 px-3 py-2.5';
const inputClass =
  'w-full min-w-0 rounded-lg border bg-card px-2 py-1 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50';

const STATE_LABEL: Record<BrainStatus['state'], Parameters<typeof t>[0]> = {
  unpaired: 'brain_state_unpaired',
  online: 'brain_state_online',
  offline: 'brain_state_offline',
  error: 'brain_state_error',
};

function StatusDot({ state }: { state: BrainStatus['state'] }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        state === 'online' && 'bg-primary shadow-[0_0_8px_rgb(var(--primary-rgb))]',
        state === 'offline' && 'bg-muted-foreground/60',
        state === 'error' && 'bg-destructive',
        state === 'unpaired' && 'bg-muted-foreground/40',
      )}
    />
  );
}

function useBrainState() {
  const [settings, setSettings] = useState<BrainSettingsValue | null>(null);
  const [status, setStatus] = useState<BrainStatus | null>(null);
  useEffect(() => {
    const load = () => {
      void brainSettingsStore.getSettings().then(setSettings);
      void brainStatusStore.getStatus().then(setStatus);
    };
    load();
    const stopSettings = brainSettingsStore.subscribe(load);
    const stopStatus = brainStatusStore.subscribe(load);
    return () => {
      stopSettings();
      stopStatus();
    };
  }, []);
  return { settings, status };
}

export default function BrainSettings({ api }: { api: PanelApi }) {
  const { settings, status } = useBrainState();
  const [code, setCode] = useState('');
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState<'pair' | 'check' | 'unpair' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);

  useEffect(() => {
    if (settings && !port) setPort(String(settings.port));
  }, [settings, port]);

  const run = useCallback(
    async (kind: 'pair' | 'check' | 'unpair', message: Record<string, unknown>) => {
      setBusy(kind);
      setError(null);
      try {
        await api.request(message, 20_000);
        if (kind === 'pair') setCode('');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(null);
      }
    },
    [api],
  );

  const online = settings?.paired && status?.state === 'online';
  useEffect(() => {
    if (!online) {
      setArtifacts([]);
      return;
    }
    let live = true;
    api
      .request<{ artifacts: Artifact[] }>({ type: 'brain_artifacts' })
      .then(reply => live && setArtifacts(reply.artifacts.slice(0, 5)))
      .catch(() => live && setArtifacts([]));
    return () => {
      live = false;
    };
  }, [api, online, status?.checkedAt]);

  // Asks once when the page opens, so what it shows is fresh
  useEffect(() => {
    if (settings?.paired) void api.request({ type: 'brain_check' }, 20_000).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.paired]);

  if (!settings || !status) return null;
  const state = settings.paired ? status.state : 'unpaired';

  return (
    <>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <StatusDot state={state} />
        <div className="min-w-0 flex-1">
          <p className="text-[13px]" role="status" aria-live="polite">
            {t(STATE_LABEL[state])}
            {state === 'online' && status.version ? (
              <span className="text-muted-foreground font-mono text-[11.5px]"> · v{status.version}</span>
            ) : null}
          </p>
          {settings.paired && status.message ? (
            <p className="text-muted-foreground text-[11.5px]">{status.message}</p>
          ) : null}
        </div>
        {settings.paired ? (
          <Button
            variant="glass"
            size="sm"
            disabled={busy !== null}
            onClick={() => void run('check', { type: 'brain_check' })}
            aria-label={t('brain_check')}>
            <RefreshCw className={cn('size-3.5', busy === 'check' && 'animate-spin')} />
            {t('brain_check')}
          </Button>
        ) : null}
      </div>

      {!settings.paired ? (
        <>
          {/* One click, no code: only ever on the user's click, so nothing that merely listens on the port is
              paired with on its own */}
          <div className={row}>
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => void run('pair', { type: 'brain_auto_pair' })}
              data-testid="brain-auto-pair">
              {busy === 'pair' ? t('brain_pairing') : t('brain_autoPair')}
            </Button>
            <p className="text-muted-foreground text-[11.5px]">{t('brain_autoPair_hint')}</p>
          </div>
          <form
            className={row}
            onSubmit={event => {
              event.preventDefault();
              void run('pair', { type: 'brain_pair', code, port: Number(port) });
            }}>
            <p className="text-muted-foreground text-[11.5px]">{t('brain_pair_hint')}</p>
            <div className="flex gap-2">
              <label className="flex w-20 flex-col gap-1 text-[11.5px]">
                {t('brain_port_label')}
                <input
                  className={inputClass}
                  inputMode="numeric"
                  value={port}
                  onChange={event => setPort(event.target.value.replace(/[^0-9]/g, '').slice(0, 5))}
                  aria-label={t('brain_port_label')}
                />
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11.5px]">
                {t('brain_code_label')}
                <input
                  className={cn(inputClass, 'font-mono uppercase tracking-wider')}
                  value={code}
                  placeholder="ABCD-2345"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={event => setCode(event.target.value.slice(0, 12))}
                  aria-label={t('brain_code_label')}
                />
              </label>
            </div>
            <Button type="submit" size="sm" disabled={busy !== null || code.trim().length < 8}>
              {busy === 'pair' ? t('brain_pairing') : t('brain_pair')}
            </Button>
          </form>
        </>
      ) : (
        <>
          {status.docker ? (
            <div className="flex items-center justify-between gap-3 px-3 py-2.5 text-[13px]">
              <span>{t('brain_docker_label')}</span>
              <span className="text-muted-foreground text-[12px]">
                {status.docker.state === 'up' && status.docker.imageReady
                  ? t('brain_docker_ready')
                  : status.docker.state === 'up'
                    ? t('brain_docker_noImage')
                    : t('brain_docker_down')}
              </span>
            </div>
          ) : null}
          {status.engine ? (
            <div className="flex items-center justify-between gap-3 px-3 py-2.5 text-[13px]">
              <span>{t('brain_engine_label')}</span>
              <span className="text-muted-foreground text-[12px]">
                {status.engine.state === 'ready'
                  ? t('brain_engine_ready')
                  : status.engine.message || t('brain_engine_off')}
              </span>
            </div>
          ) : null}
          {status.mcp.length ? (
            <div className="flex items-center justify-between gap-3 px-3 py-2.5 text-[13px]">
              <span>{t('brain_mcp_label')}</span>
              <span className="text-muted-foreground text-[12px]">
                {t('brain_mcp_count', [
                  String(status.mcp.filter(server => server.state === 'ready').length),
                  String(status.mcp.length),
                ])}
              </span>
            </div>
          ) : null}
          {artifacts.length ? (
            <div className={row}>
              <p className="text-[13px]">{t('brain_artifacts_label')}</p>
              <ul className="flex flex-col gap-1" aria-label={t('brain_artifacts_label')}>
                {artifacts.map(artifact => (
                  <li key={artifact.id} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-[12.5px]">{artifact.title}</span>
                    <Button
                      variant="glass"
                      size="sm"
                      aria-label={t('brain_artifact_open', [artifact.title])}
                      onClick={() =>
                        void api.request({ type: 'brain_open_artifact', artifactId: artifact.id }).catch(caught => {
                          setError(caught instanceof Error ? caught.message : String(caught));
                        })
                      }>
                      <ExternalLink className="size-3.5" />
                      {t('brain_artifact_openShort')}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3 px-3 py-2.5">
            <span className="text-muted-foreground text-[11.5px]">
              {t('brain_paired_on', [`127.0.0.1:${settings.port}`])}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => void run('unpair', { type: 'brain_unpair' })}>
              {t('brain_unpair')}
            </Button>
          </div>
        </>
      )}
      {error ? (
        <p role="alert" className="text-destructive px-3 py-2 text-[12px]">
          {error}
        </p>
      ) : null}
    </>
  );
}
