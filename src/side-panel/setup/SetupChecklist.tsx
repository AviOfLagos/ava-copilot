import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Circle, ExternalLink, Loader2, RotateCw } from 'lucide-react';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import { getDefaultProviderConfig, ProviderTypeEnum } from '@extension/storage';
import { REQUIRED_ITEMS, RECOMMENDED_ITEMS } from '@src/background/setup/state';
import type { SetupItemState, SetupState } from '@src/background/setup/state';
import { openSettingsPage } from '@src/shared/lib/settings-page';
import { Button } from '../components/ui/button';
import { useAssistantName } from '../hooks/useAssistant';
import { CopyCommand } from '../models/LocalSection';
import { shareable } from '../models/useProviders';
import type { PanelApi } from '../registry';
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_LOCAL_CHAT_MODEL,
  OLLAMA_DOWNLOAD_URL,
  voiceModelRequirement,
} from '../requirements/catalog';
import { OllamaInstall } from '../requirements/OllamaInstall';
import { RequirementCard, useRequirementFlow } from '../requirements/RequirementCard';
import { ITEM_TITLES, itemLine, useSetupState } from './useSetupState';

/**
 * The setup checklist (Settings › General › Setup, and the first-run setup after the model step): every part, whether
 * it is ready (from the background's checks of the real status), what is wrong in one line, and the button that
 * does it or goes exactly there. Required parts can't be skipped; a recommended one can, and can be brought back.
 */

type Api = Pick<PanelApi, 'request'>;

// The command that installs Nex Brain from the repo (companion/README.md)
export const BRAIN_INSTALL_COMMAND = 'cd <nex-copilot>/companion && pnpm install && sh scripts/install-launchagent.sh';

const openTab = (url: string) => void chrome.tabs.create({ url }).catch(() => {});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RowProps {
  item: SetupItemState;
  state: SetupState;
  api: Api;
  name: string;
  recheck: () => Promise<void>;
}

/** A button that runs a command, then checks again; it says when it fails. */
function useRun(recheck: () => Promise<void>) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const run = useCallback(
    async (key: string, work: () => Promise<unknown>, { fresh = true }: { fresh?: boolean } = {}) => {
      setBusy(key);
      setError('');
      try {
        await work();
        // Skip and Bring back only change the stored list: no need to ask every service again
        if (fresh) await recheck();
      } catch (thrown) {
        setError(errorText(thrown));
      } finally {
        setBusy(null);
      }
    },
    [recheck],
  );
  return { busy, error, run };
}

function VoiceDownload({ api, recheck }: { api: Api; recheck: () => Promise<void> }) {
  const { flow, state } = useRequirementFlow();
  return (
    <>
      {state.phase === 'idle' && (
        <Button
          size="sm"
          onClick={() =>
            void flow.choose(voiceModelRequirement(['moonshine-tiny', 'kitten'], api.request), async () => {
              await api.request({ type: 'voice_models_changed' }).catch(() => {});
              await recheck();
            })
          }>
          {t('setup_action_voice')}
        </Button>
      )}
      <div className="-mx-3 basis-full">
        <RequirementCard flow={flow} state={state} />
      </div>
    </>
  );
}

function ItemActions({ item, state, api, name, recheck }: RowProps) {
  const { busy, error, run } = useRun(recheck);
  const local = state.local;
  const brainOnline = state.items.find(entry => entry.id === 'brain')?.ready === true;
  const pulled = async () => {
    if (local?.providerId) {
      await api.request({ type: 'models_refresh', providerIds: [local.providerId] }).catch(() => {});
    }
    await recheck();
  };
  const actions: ReactNode[] = [];
  const add = (key: string, node: ReactNode) => actions.push(<span key={key}>{node}</span>);
  const button = (key: string, label: string, work: () => Promise<unknown>, variant: 'default' | 'glass' = 'glass') =>
    add(
      key,
      <Button size="sm" variant={variant} disabled={busy !== null} onClick={() => void run(key, work)}>
        {busy === key && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        {label}
      </Button>,
    );
  const link = (key: string, label: string, hash: string) =>
    add(
      key,
      <Button size="sm" variant="glass" onClick={() => void openSettingsPage(hash)}>
        {label}
      </Button>,
    );

  let extra: ReactNode = null;
  switch (item.problem) {
    case 'model_missing':
      link('models', t('setup_action_models'), '#models');
      break;
    case 'local_off':
      add(
        'download',
        <Button size="sm" variant="glass" onClick={() => openTab(OLLAMA_DOWNLOAD_URL)}>
          <ExternalLink className="size-3.5" aria-hidden />
          {t('setup_action_getOllama')}
        </Button>,
      );
      if (brainOnline) {
        button('open', t('setup_action_openOllama'), async () => {
          await api.request({ type: 'setup_open_app', app: local?.kind ?? 'ollama' }, 25_000);
          // The server needs a moment to answer once the app is open
          await new Promise(resolve => setTimeout(resolve, 4000));
        });
      } else {
        extra = <p className="text-muted-foreground text-[11.5px]">{t('setup_hint_openOllama')}</p>;
      }
      break;
    case 'local_not_added':
      button(
        'add',
        t(local?.kind === 'lmstudio' ? 'setup_action_addLmStudio' : 'setup_action_addOllama'),
        async () => {
          const type = local?.kind === 'lmstudio' ? ProviderTypeEnum.LMStudio : ProviderTypeEnum.Ollama;
          const probe = await api
            .request<{ local?: { kind: string; models: string[] }[] }>({ type: 'models_local_probe' }, 10_000)
            .catch(() => ({ local: [] }));
          const config = getDefaultProviderConfig(type);
          const listed = probe.local?.find(entry => entry.kind === local?.kind)?.models ?? [];
          if (listed.length) config.modelNames = listed.slice(0, 20);
          await api.request({ type: 'models_provider_save', providerId: type, config: shareable(config) }, 30_000);
        },
        'default',
      );
      break;
    case 'local_no_chat':
      if (local?.kind === 'lmstudio') {
        extra = <p className="text-muted-foreground text-[11.5px]">{t('setup_hint_lmStudioModel')}</p>;
      } else {
        extra = <OllamaInstall model={DEFAULT_LOCAL_CHAT_MODEL} sizeBytes={2.5e9} onInstalled={() => void pulled()} />;
      }
      break;
    case 'local_no_embed':
      if (local?.kind === 'lmstudio') {
        extra = <p className="text-muted-foreground text-[11.5px]">{t('setup_hint_lmStudioEmbed')}</p>;
      } else {
        extra = <OllamaInstall model={DEFAULT_EMBED_MODEL} sizeBytes={274e6} onInstalled={() => void pulled()} />;
      }
      break;
    case 'voice_missing':
      extra = <VoiceDownload api={api} recheck={recheck} />;
      break;
    case 'brain_unreachable':
    case 'brain_offline':
      extra = (
        <div className="basis-full">
          <p className="text-muted-foreground text-[11.5px]">{t('setup_hint_brainInstall')}</p>
          <CopyCommand command={BRAIN_INSTALL_COMMAND} />
        </div>
      );
      break;
    case 'brain_unpaired':
      button('pair', t('setup_action_pair'), () => api.request({ type: 'brain_auto_pair' }, 20_000), 'default');
      break;
    case 'ava_signed_out':
    case 'ava_unchecked':
      button('signin', t('setup_action_avaSignin', [name]), () => api.request({ type: 'meetvoice_signin' }, 20_000));
      button('check', t('setup_action_avaCheck'), () => api.request({ type: 'meetvoice_check' }, 50_000));
      break;
    case 'wa_not_linked':
      link('wa', t('setup_action_whatsapp'), '#connections/whatsapp-remote');
      break;
    case 'cal_none':
    case 'cal_error':
      link('cal', t('setup_action_calendar'), '#connections/calendar');
      break;
    case 'obs_none':
      link('obs', t('setup_action_obsidian'), '#connections/obsidian');
      break;
    case 'backup_never':
    case 'backup_failed':
      button('backup', t('setup_action_backup'), () => api.request({ type: 'backup_now' }, 180_000), 'default');
      break;
    case 'needs_brain':
      link('brain', t('setup_action_brain'), '#connections/brain');
      break;
    default:
      break;
  }

  if (!actions.length && !extra && !error) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {actions}
      {extra}
      {error && (
        <p role="alert" className="text-destructive basis-full text-[11.5px]">
          {error}
        </p>
      )}
    </div>
  );
}

function ItemRow(props: RowProps & { skipped: boolean; recommended: boolean }) {
  const { item, api, name, skipped, recommended, recheck } = props;
  const { busy, run } = useRun(recheck);
  const title = t(ITEM_TITLES[item.id]);
  return (
    <li
      className="flex gap-2.5 px-3 py-2.5"
      data-setup-item={item.id}
      data-ready={item.ready ? 'true' : 'false'}
      data-skipped={skipped ? 'true' : undefined}>
      <span aria-hidden="true" className="mt-0.5 shrink-0">
        {item.ready ? (
          <Check className="text-primary size-4" />
        ) : (
          <Circle className={cn('size-4', skipped ? 'text-muted-foreground/50' : 'text-muted-foreground')} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn('min-w-0 flex-1 text-[13px]', skipped && 'text-muted-foreground')}>
            {title}
            <span className="sr-only">
              {' '}
              {item.ready ? t('setup_ready') : skipped ? t('setup_skipped') : t('setup_notReady')}
            </span>
          </span>
          {recommended && !item.ready && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              aria-label={t(skipped ? 'setup_unskip_named' : 'setup_skip_named', [title])}
              onClick={() =>
                void run('skip', () => api.request({ type: skipped ? 'setup_unskip' : 'setup_skip', id: item.id }), {
                  fresh: false,
                })
              }>
              {t(skipped ? 'setup_unskip' : 'setup_skip')}
            </Button>
          )}
        </div>
        <p className={cn('text-[11.5px]', item.ready ? 'text-muted-foreground' : 'text-foreground/80')} data-setup-line>
          {itemLine(item, name)}
        </p>
        {item.id === 'brain' && props.state.brain?.docker && props.state.brain.docker !== 'up' && (
          <p className="text-muted-foreground text-[11px]">
            {t('setup_info_docker', [props.state.brain.dockerMessage ?? props.state.brain.docker])}
          </p>
        )}
        {!item.ready && !skipped && <ItemActions {...props} />}
      </div>
    </li>
  );
}

export default function SetupChecklist({
  api,
  placement = 'settings',
}: {
  api: Api;
  placement?: 'settings' | 'onboarding';
}) {
  const state = useSetupState();
  const name = useAssistantName();
  const [checking, setChecking] = useState(false);
  // The caller may hand a new object each render: the first check runs once
  const apiRef = useRef(api);
  apiRef.current = api;

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      await apiRef.current.request({ type: 'setup_status', fresh: true }, 60_000);
    } catch {
      // The stored state stays; the next scheduled check tries again
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void recheck();
  }, [recheck]);

  const items = state?.items ?? [];
  const byId = new Map(items.map(entry => [entry.id, entry]));
  const group = (ids: typeof REQUIRED_ITEMS, label: string, recommended: boolean) => (
    <section aria-label={label} className={cn(placement === 'onboarding' && 'glass rounded-2xl')}>
      <h3 className="label-mono px-3 pt-2.5">{label}</h3>
      <ul className="divide-border/60 divide-y">
        {ids.map(id => {
          const item = byId.get(id);
          if (!item) return null;
          return (
            <ItemRow
              key={id}
              item={item}
              state={state!}
              api={api}
              name={name}
              recheck={recheck}
              recommended={recommended}
              skipped={recommended && (state?.skipped ?? []).includes(id)}
            />
          );
        })}
      </ul>
    </section>
  );

  return (
    <div className="flex flex-col gap-2" data-testid="setup-checklist" data-pending={state?.pending ?? ''}>
      <div className="flex items-center gap-2 px-3 pt-2">
        <p className="text-muted-foreground min-w-0 flex-1 text-[12px]" role="status" aria-live="polite">
          {!state?.checkedAt
            ? t('setup_checking')
            : state.pending
              ? t('setup_summary_pending', [String(state.pending)])
              : t('setup_summary_done')}
        </p>
        <Button size="sm" variant="ghost" disabled={checking} onClick={() => void recheck()}>
          {checking ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <RotateCw className="size-3.5" aria-hidden />
          )}
          {t('setup_checkAgain')}
        </Button>
      </div>
      {items.length > 0 && (
        <>
          {group(REQUIRED_ITEMS, t('setup_group_required'), false)}
          {group(RECOMMENDED_ITEMS, t('setup_group_recommended'), true)}
        </>
      )}
    </div>
  );
}
