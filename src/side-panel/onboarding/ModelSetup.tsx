import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Cpu, Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import {
  AgentNameEnum,
  agentModelStore,
  getDefaultDisplayNameFromProviderId,
  getDefaultProviderConfig,
  modelSettingsStore,
  ProviderTypeEnum,
  recommendLocalModels,
  platformOf,
  tagsFromName,
  TAG,
} from '@extension/storage';
import type {
  LocalServerKind,
  LocalServerProbe,
  ModelConfig,
  ProviderConfig,
  ProviderHealth,
} from '@extension/storage';
import { Button } from '../components/ui/button';
import { CopyCommand } from '../models/LocalSection';
import { inputClass, Segmented } from '../models/ui';
import { shareable, useProviders } from '../models/useProviders';
import type { ModelsRequest } from '../models/useProviders';

/**
 * The first-run model step: connect one model that works, either a server on this computer (Ollama, LM Studio,
 * found by looking every few seconds while the step is open) or a provider's API key, checked before it is saved.
 * Saving gives the Planner and the Navigator the provider's defaults (background/models/commands.ts), so the panel
 * is ready as soon as one works.
 */

type MessageKey = Parameters<typeof t>[0];

const LOCAL_KINDS: LocalServerKind[] = ['ollama', 'lmstudio'];
const LOCAL_NAMES: Record<LocalServerKind, string> = { ollama: 'Ollama', lmstudio: 'LM Studio' };
const LOCAL_TYPES: Record<LocalServerKind, ProviderTypeEnum> = {
  ollama: ProviderTypeEnum.Ollama,
  lmstudio: ProviderTypeEnum.LMStudio,
};
// Providers set up with a key alone (Azure needs deployments: Models & usage has it)
const KEY_TYPES: ProviderTypeEnum[] = [
  ProviderTypeEnum.Gemini,
  ProviderTypeEnum.OpenAI,
  ProviderTypeEnum.Anthropic,
  ProviderTypeEnum.OpenRouter,
  ProviderTypeEnum.DeepSeek,
  ProviderTypeEnum.Grok,
  ProviderTypeEnum.Nvidia,
  ProviderTypeEnum.CustomOpenAI,
];
const HINTS: Record<NonNullable<ProviderHealth['hint']>, MessageKey> = {
  ollama_origins: 'models_hint_ollama_origins',
  needs_key: 'models_hint_needs_key',
  key_rejected: 'models_hint_key_rejected',
  unreachable: 'models_hint_unreachable',
};
export const PROBE_EVERY_MS = 3000;
// Saving lists the provider's models, which may be slow
const CHECK_TIMEOUT_MS = 45_000;

interface CheckReply {
  health: ProviderHealth | null;
  models?: number;
  // The first few model names, never the key
  sample?: string[];
}

/** A few model names, for "it works" lines. */
function sampleText(reply: CheckReply): string {
  const names = reply.sample ?? [];
  const shown = names.slice(0, 3).join(', ');
  return (reply.models ?? names.length) > 3 ? `${shown}…` : shown;
}

function healthError(health: ProviderHealth): string {
  return health.hint ? t(HINTS[health.hint]) : health.error || t('models_error_generic');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerLabel(type: ProviderTypeEnum): string {
  return type === ProviderTypeEnum.CustomOpenAI
    ? t('options_models_providers_openaiCompatible')
    : getDefaultDisplayNameFromProviderId(type);
}

/** The agents' models, as saved, following every change. */
function useAgentModels(): Partial<Record<AgentNameEnum, ModelConfig>> {
  const [models, setModels] = useState<Partial<Record<AgentNameEnum, ModelConfig>>>({});
  useEffect(() => {
    let alive = true;
    const read = () => void agentModelStore.getAllAgentModels().then(next => alive && setModels(next ?? {}));
    read();
    const stop = agentModelStore.subscribe(read);
    return () => {
      alive = false;
      stop();
    };
  }, []);
  return models;
}

/** The Ollama model to suggest pulling on this computer, from what the browser tells about it. */
function suggestedPull(): string {
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { platform?: string } };
  const picks = recommendLocalModels(
    {
      reportedMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
      userMemoryGb: null,
      cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
      platform: platformOf(nav.userAgentData?.platform ?? nav.platform),
      gpu: null,
    },
    [],
  );
  return (picks.find(pick => pick.kind === 'chat') ?? picks[0]).command;
}

/** Looks for local servers now and every few seconds while mounted; the latest answer, null before the first. */
function useLocalProbe(request: ModelsRequest): Partial<Record<LocalServerKind, LocalServerProbe>> | null {
  const [found, setFound] = useState<Partial<Record<LocalServerKind, LocalServerProbe>> | null>(null);
  // The panel makes a new request function on every render; the loop keeps the latest
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const reply = await requestRef.current<{ local?: LocalServerProbe[] }>({ type: 'models_local_probe' }, 10_000);
        if (alive) setFound(Object.fromEntries((reply.local ?? []).map(probe => [probe.kind, probe])));
      } catch {
        // The next look tries again
      }
      if (alive) timer = window.setTimeout(() => void tick(), PROBE_EVERY_MS);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);
  return found;
}

function StatusLine({ tone, children }: { tone: 'busy' | 'ok' | 'error' | 'muted'; children: ReactNode }) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-1.5 text-[11.5px] leading-snug',
        tone === 'error' ? 'text-destructive' : tone === 'ok' ? 'text-foreground' : 'text-muted-foreground',
      )}>
      {tone === 'busy' && <Loader2 aria-hidden="true" className="mt-px size-3 shrink-0 animate-spin" />}
      {tone === 'ok' && <Check aria-hidden="true" className="text-primary mt-px size-3 shrink-0" />}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

export interface ModelSetupProps {
  request: ModelsRequest;
  // Whether the Navigator has a model that can be called (the panel's own check)
  hasModel: boolean | null;
  name: string;
  onOpenModels: () => void;
}

export default function ModelSetup({ request, hasModel, name, onOpenModels }: ModelSetupProps) {
  const providers = useProviders(request);
  const agents = useAgentModels();
  const probes = useLocalProbe(request);
  const [tab, setTab] = useState<'local' | 'key'>('local');

  const navigatorModel = agents[AgentNameEnum.Navigator];
  const using =
    hasModel && navigatorModel
      ? t('onboard_model_using', [
          navigatorModel.modelName,
          providers.saved[navigatorModel.provider]?.name ||
            getDefaultDisplayNameFromProviderId(navigatorModel.provider),
        ])
      : '';

  return (
    <div className="flex flex-col gap-3" data-testid="model-setup">
      <p id="onboard-body" className="text-muted-foreground text-[13px] leading-relaxed">
        {t('onboard_model_intro', [name])}
      </p>

      {hasModel && (
        <div className="border-primary/40 bg-primary/10 flex items-start gap-2 rounded-2xl border px-3 py-2.5">
          <Check aria-hidden="true" className="text-primary mt-0.5 size-4 shrink-0" />
          <p role="status" className="min-w-0 text-[12.5px] leading-snug" data-testid="model-ready">
            <span className="font-medium">{t('onboard_model_readyTitle')}</span>{' '}
            <span className="text-muted-foreground break-words">{using}</span>
          </p>
        </div>
      )}

      <Segmented
        label={t('onboard_model_choose')}
        value={tab}
        onChange={setTab}
        options={[
          { value: 'local', label: t('onboard_model_tab_local') },
          { value: 'key', label: t('onboard_model_tab_key') },
        ]}
      />

      {tab === 'local' ? (
        <LocalChoice
          request={request}
          providers={providers}
          probes={probes}
          navigator={navigatorModel}
          onUseKey={() => setTab('key')}
        />
      ) : (
        <KeyChoice request={request} providers={providers} />
      )}

      <button
        type="button"
        onClick={onOpenModels}
        className="text-muted-foreground hover:text-foreground self-start text-[11.5px] underline-offset-2 hover:underline">
        {t('onboard_model_more')}
      </button>
    </div>
  );
}

type Providers = ReturnType<typeof useProviders>;

function LocalChoice({
  request,
  providers,
  probes,
  navigator: current,
  onUseKey,
}: {
  request: ModelsRequest;
  providers: Providers;
  probes: Partial<Record<LocalServerKind, LocalServerProbe>> | null;
  navigator: ModelConfig | undefined;
  onUseKey: () => void;
}) {
  const [busy, setBusy] = useState<LocalServerKind | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [pull] = useState(suggestedPull);

  const add = async (kind: LocalServerKind) => {
    const type = LOCAL_TYPES[kind];
    const config = getDefaultProviderConfig(type);
    const listed = probes?.[kind]?.models ?? [];
    if (listed.length) config.modelNames = listed.slice(0, 20);
    setBusy(kind);
    setError('');
    setNote('');
    try {
      const reply = await request<CheckReply & { assigned?: Record<string, unknown> }>(
        { type: 'models_provider_save', providerId: type, config: shareable(config) },
        CHECK_TIMEOUT_MS,
      );
      if (reply.health?.status === 'error') setError(healthError(reply.health));
      else if (!Object.keys(reply.assigned ?? {}).length && !current) setNote(t('onboard_model_local_noChat'));
    } catch (thrown) {
      setError(errorText(thrown));
    } finally {
      setBusy(null);
    }
  };

  // The model picked here does both kinds of work: one local model at a time fits in memory
  const choose = async (providerId: string, model: string) => {
    setError('');
    try {
      for (const [agent, role] of [
        [AgentNameEnum.Planner, 'smart'],
        [AgentNameEnum.Navigator, 'fast'],
      ] as const) {
        await modelSettingsStore.setRole(role, { providerId, model });
        await agentModelStore.setAgentModel(agent, { provider: providerId, modelName: model });
      }
    } catch (thrown) {
      setError(errorText(thrown));
    }
  };

  const rows = LOCAL_KINDS.map(kind => ({ kind, probe: probes?.[kind], saved: providers.saved[LOCAL_TYPES[kind]] }));
  const anything = rows.some(row => row.saved || (row.probe && row.probe.status !== 'absent'));

  return (
    <div className="glass flex flex-col gap-3 rounded-2xl px-3 py-3" data-testid="local-choice">
      {rows.map(({ kind, probe, saved }) => {
        const type = LOCAL_TYPES[kind];
        if (saved) {
          const choices = providers.modelChoices(type).filter(model => tagsFromName(model).includes(TAG.chat));
          const value = current?.provider === type ? current.modelName : '';
          const selectId = `onboard-local-${kind}`;
          return (
            <div key={kind} className="flex flex-col gap-1.5" data-local-connected={kind}>
              <StatusLine tone="ok">{t('onboard_model_local_connected', [LOCAL_NAMES[kind]])}</StatusLine>
              {choices.length > 0 && (
                <>
                  <label htmlFor={selectId} className="label-mono">
                    {t('onboard_model_local_model')}
                  </label>
                  <select
                    id={selectId}
                    value={value}
                    onChange={event => event.target.value && void choose(type, event.target.value)}
                    className={cn(inputClass, 'h-9 px-2.5 text-[13px]')}>
                    {!value && <option value="">{t('onboard_model_local_pick')}</option>}
                    {choices.map(model => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
          );
        }
        if (!probe || probe.status === 'absent') return null;
        if (probe.status === 'refused') {
          return (
            <div key={kind} className="flex flex-col gap-1" data-local-offer={kind}>
              <p className="text-[12.5px]">{t('models_local_refused', [LOCAL_NAMES[kind]])}</p>
              {kind === 'ollama' && (
                <p className="text-muted-foreground text-[11.5px] leading-snug">{t('models_hint_ollama_origins')}</p>
              )}
            </div>
          );
        }
        if (probe.models.length === 0) {
          return (
            <div key={kind} className="flex flex-col gap-1" data-local-offer={kind}>
              <p className="text-[12.5px]">{t('onboard_model_local_empty', [LOCAL_NAMES[kind]])}</p>
              {kind === 'ollama' && <CopyCommand command={pull} />}
            </div>
          );
        }
        return (
          <div key={kind} className="flex items-center gap-2" data-local-offer={kind}>
            <p className="min-w-0 flex-1 text-[12.5px] leading-snug">
              {t('models_local_found', [LOCAL_NAMES[kind], String(probe.models.length)])}
            </p>
            <Button size="sm" disabled={busy !== null} onClick={() => void add(kind)}>
              {busy === kind ? <Loader2 className="size-3.5 animate-spin" /> : <Cpu className="size-3.5" />}
              {t('onboard_model_local_use', [LOCAL_NAMES[kind]])}
            </Button>
          </div>
        );
      })}

      {!anything && (
        <div className="flex flex-col gap-2" data-testid="local-instructions">
          <p className="text-[12.5px] leading-snug">{t('onboard_model_local_none')}</p>
          <ol className="text-muted-foreground flex list-decimal flex-col gap-1.5 pl-4 text-[12px] leading-snug">
            <li>{t('onboard_model_local_install')}</li>
            <li>
              {t('onboard_model_local_pull')}
              <CopyCommand command={pull} />
            </li>
          </ol>
          <StatusLine tone="busy">
            {probes === null ? t('onboard_model_local_looking') : t('onboard_model_local_watching')}
          </StatusLine>
          <button
            type="button"
            onClick={onUseKey}
            className="text-primary self-start text-[11.5px] underline-offset-2 hover:underline">
            {t('onboard_model_local_orKey')}
          </button>
        </div>
      )}

      {note && <StatusLine tone="muted">{note}</StatusLine>}
      {error && <StatusLine tone="error">{error}</StatusLine>}
    </div>
  );
}

function KeyChoice({ request, providers }: { request: ModelsRequest; providers: Providers }) {
  const [type, setType] = useState<ProviderTypeEnum>(ProviderTypeEnum.Gemini);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState<{ tone: 'busy' | 'ok' | 'error'; text: string } | null>(null);
  const custom = type === ProviderTypeEnum.CustomOpenAI;

  /** The provider id this key is saved under: the kind itself, or a custom endpoint's own (reused per address). */
  const idFor = (): string => {
    if (!custom) return type;
    const address = baseUrl.trim().replace(/\/+$/, '');
    const same = Object.entries(providers.saved).find(
      ([, config]) =>
        config.type === ProviderTypeEnum.CustomOpenAI && (config.baseUrl ?? '').trim().replace(/\/+$/, '') === address,
    );
    if (same) return same[0];
    let number = 1;
    while (providers.saved[`${ProviderTypeEnum.CustomOpenAI}_${number}`]) number += 1;
    return `${ProviderTypeEnum.CustomOpenAI}_${number}`;
  };

  const connect = async () => {
    if (!apiKey.trim()) {
      setStatus({ tone: 'error', text: t('onboard_model_key_missing') });
      return;
    }
    if (custom && !/^https?:\/\/\S+$/i.test(baseUrl.trim())) {
      setStatus({ tone: 'error', text: t('onboard_model_key_badUrl') });
      return;
    }
    const id = idFor();
    const base: ProviderConfig = providers.saved[id] ?? getDefaultProviderConfig(id);
    const config: ProviderConfig = {
      ...base,
      type,
      ...(custom
        ? // Named after its server (a provider name has no spaces), unless it was saved with a name already
          { baseUrl: baseUrl.trim(), name: providers.saved[id]?.name?.trim() || new URL(baseUrl.trim()).hostname }
        : {}),
    };
    const message = { providerId: id, config: shareable(config), apiKey: apiKey.trim() };
    setStatus({ tone: 'busy', text: t('onboard_model_key_checking') });
    try {
      // Tried first without saving, so a key that does not work is never kept
      const checked = await request<CheckReply>({ type: 'models_provider_check', ...message }, CHECK_TIMEOUT_MS);
      if (checked.health?.status === 'error') {
        setStatus({ tone: 'error', text: healthError(checked.health) });
        return;
      }
      if (custom && !checked.models) {
        setStatus({ tone: 'error', text: t('onboard_model_key_noList') });
        return;
      }
      const saved = await request<CheckReply>({ type: 'models_provider_save', ...message }, CHECK_TIMEOUT_MS);
      if (saved.health?.status === 'error') {
        setStatus({ tone: 'error', text: healthError(saved.health) });
        return;
      }
      setApiKey('');
      setStatus({
        tone: 'ok',
        text: t('onboard_model_key_ok', [
          config.name || providerLabel(type),
          sampleText(saved.sample ? saved : checked),
        ]),
      });
    } catch (thrown) {
      setStatus({ tone: 'error', text: errorText(thrown) });
    }
  };

  const savedHere = providers.saved[custom ? '' : type];
  return (
    <form
      className="glass flex flex-col gap-2.5 rounded-2xl px-3 py-3"
      data-testid="key-choice"
      onSubmit={event => {
        event.preventDefault();
        void connect();
      }}>
      <div className="flex flex-col gap-1">
        <label htmlFor="onboard-key-provider" className="label-mono">
          {t('onboard_model_key_provider')}
        </label>
        <select
          id="onboard-key-provider"
          value={type}
          onChange={event => {
            setType(event.target.value as ProviderTypeEnum);
            setStatus(null);
          }}
          className={cn(inputClass, 'h-9 px-2.5 text-[13px]')}>
          {KEY_TYPES.map(option => (
            <option key={option} value={option}>
              {providerLabel(option)}
            </option>
          ))}
        </select>
      </div>
      {custom && (
        <div className="flex flex-col gap-1">
          <label htmlFor="onboard-key-url" className="label-mono">
            {t('models_baseUrl')}
          </label>
          <input
            id="onboard-key-url"
            type="url"
            value={baseUrl}
            onChange={event => {
              setBaseUrl(event.target.value);
              setStatus(null);
            }}
            placeholder="https://…/v1"
            className={cn(inputClass, 'h-9 px-2.5 font-mono text-[12.5px]')}
          />
        </div>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor="onboard-key" className="label-mono">
          {t('models_key_label')}
          {savedHere?.hasKey && savedHere.keyLast4 ? ` · ••••${savedHere.keyLast4}` : ''}
        </label>
        <div className="flex items-center gap-1">
          <input
            id="onboard-key"
            type={showKey ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={event => {
              setApiKey(event.target.value);
              if (status?.tone !== 'busy') setStatus(null);
            }}
            className={cn(inputClass, 'h-9 flex-1 px-2.5 font-mono text-[12.5px]')}
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label={showKey ? t('onboard_model_key_hide') : t('onboard_model_key_show')}
            onClick={() => setShowKey(!showKey)}>
            {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </Button>
        </div>
      </div>
      <Button type="submit" size="sm" className="self-start" disabled={status?.tone === 'busy'}>
        <KeyRound className="size-3.5" />
        {t('onboard_model_key_connect')}
      </Button>
      {status && <StatusLine tone={status.tone}>{status.text}</StatusLine>}
      <p className="text-muted-foreground text-[11px] leading-snug">{t('models_key_vault')}</p>
    </form>
  );
}
