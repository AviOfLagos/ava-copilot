import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { t } from '@extension/i18n';
import {
  baseModelName,
  getDefaultDisplayNameFromProviderId,
  localChatModels,
  memoryEstimate,
  modelSettingsStore,
  pickFallbackModel,
  platformOf,
  recommendLocalModels,
} from '@extension/storage';
import type { LightRoute, RecommendationKind, SystemSpec } from '@extension/storage';
import { cn } from '@extension/ui';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { inputClass, Section, Segmented } from './ui';
import type { ModelSettingsState } from './useModelSettings';
import { useModelTest } from './useModelTest';
import type { ProvidersState } from './useProviders';

type MessageKey = Parameters<typeof t>[0];

const KIND_LABEL: Record<RecommendationKind, { name: MessageKey; why: MessageKey }> = {
  chat: { name: 'models_rec_chat', why: 'models_rec_chat_why' },
  light: { name: 'models_rec_light', why: 'models_rec_light_why' },
  vision: { name: 'models_rec_vision', why: 'models_rec_vision_why' },
  embed: { name: 'models_rec_embed', why: 'models_rec_embed_why' },
};

const MEMORY_CHOICES = ['', '8', '16', '32', '64'] as const;
type MemoryChoice = (typeof MEMORY_CHOICES)[number];

interface BrowserSpec {
  reportedMemoryGb: number | null;
  cores: number | null;
  platform: string | null;
  gpu: { vendor: string; architecture: string } | null;
  webgpu: boolean;
}

interface LocalReport {
  running: boolean;
  providerId: string | null;
  installed: { name: string; sizeBytes: number | null }[];
  loaded: { name: string; sizeBytes: number | null }[];
}

/** What the browser tells about this computer. Nothing here leaves the browser. */
function useBrowserSpec(): BrowserSpec | null {
  const [spec, setSpec] = useState<BrowserSpec | null>(null);
  useEffect(() => {
    let alive = true;
    const nav = navigator as Navigator & {
      deviceMemory?: number;
      userAgentData?: { platform?: string };
      gpu?: { requestAdapter: () => Promise<{ info?: { vendor?: string; architecture?: string } } | null> };
    };
    const base = {
      reportedMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
      cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
      platform: platformOf(nav.userAgentData?.platform ?? nav.platform),
    };
    const done = (gpu: BrowserSpec['gpu'], webgpu: boolean) => alive && setSpec({ ...base, gpu, webgpu });
    if (!nav.gpu) done(null, false);
    else
      nav.gpu
        .requestAdapter()
        .then(adapter =>
          done(
            adapter?.info ? { vendor: adapter.info.vendor ?? '', architecture: adapter.info.architecture ?? '' } : null,
            Boolean(adapter),
          ),
        )
        .catch(() => done(null, false));
    return () => {
      alive = false;
    };
  }, []);
  return spec;
}

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="bg-muted/60 mt-1 flex items-center gap-1 rounded-lg py-0.5 pl-2 pr-0.5">
      <code className="min-w-0 flex-1 truncate font-mono text-[11.5px]" data-command>
        {command}
      </code>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={copied ? t('models_rec_copied') : t('models_rec_copy', [command])}
        onClick={() =>
          void navigator.clipboard?.writeText(command).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            },
            () => {},
          )
        }>
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  );
}

/** Where light work goes, with the setting and the one-time "start a local model or allow the cloud" choice. */
function LightRouting({
  state,
  models,
  route,
  checking,
  recheck,
}: {
  state: ProvidersState;
  models: ModelSettingsState;
  route: LightRoute | null;
  checking: boolean;
  recheck: () => void;
}) {
  const { settings } = models;
  const providerName = (id: string) => state.saved[id]?.name || getDefaultDisplayNameFromProviderId(id);
  const cloud = models.resolve('fast');
  let status = '';
  if (route?.route === 'local') {
    status = t('models_light_local', [`${providerName(route.target.providerId)} · ${route.target.model}`]);
  } else if (route?.route === 'cloud') {
    const name = cloud ? `${providerName(cloud.providerId)} · ${cloud.model}` : t('models_light_noCloud');
    status = t(route.reason === 'preferCloud' ? 'models_light_cloudChosen' : 'models_light_cloud', [name]);
  }
  const waiting = settings.preferLocalLight && route?.route === 'cloud' && !settings.lightCloudAllowed;
  return (
    <Section label={t('models_light')}>
      <div className="flex items-start gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-[13px]">{t('models_light_prefer')}</p>
          <p className="text-muted-foreground text-[11.5px]">{t('models_light_prefer_hint')}</p>
        </div>
        <Switch
          checked={settings.preferLocalLight}
          label={t('models_light_prefer')}
          onChange={value => void modelSettingsStore.updateSettings({ preferLocalLight: value }).then(recheck)}
        />
      </div>
      <div className="px-3 py-2.5" data-light-route={route?.route ?? ''}>
        <p role="status" className="text-[12px]">
          {checking && !route ? t('models_checking') : status}
        </p>
        {waiting && (
          <div className="bg-muted/40 mt-1.5 rounded-lg px-2 py-1.5" data-light-notice>
            <p className="text-[11.5px]">{t('models_light_notice_body')}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <Button size="sm" variant="glass" disabled={checking} onClick={recheck}>
                {checking ? t('models_checking') : t('models_light_recheck')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void modelSettingsStore.updateSettings({ lightCloudAllowed: true }).then(recheck)}>
                {t('models_light_allowCloud')}
              </Button>
            </div>
          </div>
        )}
        {settings.preferLocalLight && settings.lightCloudAllowed && (
          <p className="text-muted-foreground mt-1 flex items-center gap-1 text-[11px]">
            {t('models_light_cloudAllowed')}
            <button
              type="button"
              className="hover:text-foreground underline underline-offset-2"
              onClick={() => void modelSettingsStore.updateSettings({ lightCloudAllowed: false }).then(recheck)}>
              {t('models_light_cloudAllowed_undo')}
            </button>
          </p>
        )}
      </div>
    </Section>
  );
}

// Provider ids never hold it, so the first one splits a value into provider and model
const SEPARATOR = '|';
const RECOMMENDATIONS_ID = 'models-local-recommendations';

/** "When the cloud fails": the local model a failed cloud call finishes on, and the switch for it. */
function CloudFallback({ state, models }: { state: ProvidersState; models: ModelSettingsState }) {
  const { settings } = models;
  const setting = settings.fallbackLocal;
  const providerName = (id: string) => state.saved[id]?.name || getDefaultDisplayNameFromProviderId(id);
  const found = useMemo(() => {
    const seen = new Map<string, { providerId: string; model: string }>();
    for (const entry of localChatModels({ providers: state.saved, catalog: state.catalog })) {
      seen.set(`${entry.providerId}${SEPARATOR}${entry.model}`, entry);
    }
    return [...seen.values()];
  }, [state.saved, state.catalog]);
  const inputs = { providers: state.saved, catalog: state.catalog, health: state.health.providers, activeOnly: true };
  const automatic = pickFallbackModel(
    { ...inputs, settings: { ...settings, fallbackLocal: { enabled: true, model: null } } },
    { ignoreEnabled: true },
  );
  const current = pickFallbackModel({ ...inputs, settings }, { ignoreEnabled: true });
  const chosen = setting.model;
  const byProvider = new Map<string, string[]>();
  for (const entry of found)
    byProvider.set(entry.providerId, [...(byProvider.get(entry.providerId) ?? []), entry.model]);
  const update = (changes: Partial<typeof setting>) =>
    void modelSettingsStore.updateSettings({ fallbackLocal: { ...setting, ...changes } });
  const selectId = 'models-fallback-model';

  return (
    <Section label={t('models_fallback')}>
      <div className="flex items-start gap-3 px-3 py-2.5" data-fallback={setting.enabled ? 'on' : 'off'}>
        <div className="min-w-0 flex-1">
          <p className="text-[13px]">{t('models_fallback_enable')}</p>
          <p className="text-muted-foreground text-[11.5px]">{t('models_fallback_enable_hint')}</p>
        </div>
        <Switch
          checked={setting.enabled}
          label={t('models_fallback_enable')}
          onChange={value => update({ enabled: value })}
        />
      </div>
      {found.length === 0 ? (
        <div className="px-3 py-2.5" data-fallback-empty>
          <p className="text-[12px]">{t('models_fallback_none')}</p>
          <Button
            size="sm"
            variant="glass"
            className="mt-1"
            onClick={() =>
              document.getElementById(RECOMMENDATIONS_ID)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }>
            {t('models_fallback_install')}
          </Button>
        </div>
      ) : (
        <div className="px-3 py-2.5">
          <label htmlFor={selectId} className="text-muted-foreground mb-1 block text-[11.5px]">
            {t('models_fallback_model')}
          </label>
          <select
            id={selectId}
            value={chosen ? `${chosen.providerId}${SEPARATOR}${chosen.model}` : ''}
            disabled={!setting.enabled}
            onChange={event => {
              const at = event.target.value.indexOf(SEPARATOR);
              update({
                model:
                  at > 0
                    ? { providerId: event.target.value.slice(0, at), model: event.target.value.slice(at + 1) }
                    : null,
              });
            }}
            className={inputClass}>
            <option value="">
              {automatic
                ? t('models_fallback_auto', [`${providerName(automatic.providerId)} · ${automatic.model}`])
                : t('models_fallback_autoNone')}
            </option>
            {[...byProvider].map(([providerId, names]) => (
              <optgroup key={providerId} label={providerName(providerId)}>
                {[...new Set(names)].sort().map(model => (
                  <option key={model} value={`${providerId}${SEPARATOR}${model}`}>
                    {model}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {setting.enabled && current && (
            <p role="status" className="text-muted-foreground mt-1 text-[11px]" data-fallback-model={current.model}>
              {t('models_fallback_using', [`${providerName(current.providerId)} · ${current.model}`])}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

/**
 * Local models: where light work goes, the local model a failed cloud call finishes on, and 2–4 models that fit
 * this computer with the command that installs each and a test once installed. Says plainly what a browser cannot
 * see.
 */
export default function LocalSection({ state, models }: { state: ProvidersState; models: ModelSettingsState }) {
  const browser = useBrowserSpec();
  const [report, setReport] = useState<LocalReport | null>(null);
  const [route, setRoute] = useState<LightRoute | null>(null);
  const [checking, setChecking] = useState(false);
  const test = useModelTest(state);
  const { request } = state;

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const [nextReport, nextRoute] = await Promise.all([
        request<LocalReport>({ type: 'models_local_report' }).catch(() => null),
        request<{ route: LightRoute }>({ type: 'models_light_route' }).catch(() => null),
      ]);
      setReport(nextReport);
      setRoute(nextRoute?.route ?? null);
    } finally {
      setChecking(false);
    }
  }, [request]);

  useEffect(() => {
    void check();
  }, [check]);

  const localEntries = useMemo(() => state.catalog.filter(entry => entry.local), [state.catalog]);
  const installed = useMemo(
    () => [...new Set([...localEntries.map(entry => entry.model), ...(report?.installed ?? []).map(m => m.name)])],
    [localEntries, report],
  );
  const memoryChoice = (models.settings.localMemoryGb ? String(models.settings.localMemoryGb) : '') as MemoryChoice;
  const spec: SystemSpec | null = browser && {
    reportedMemoryGb: browser.reportedMemoryGb,
    userMemoryGb: models.settings.localMemoryGb,
    cores: browser.cores,
    platform: browser.platform,
    gpu: browser.gpu,
  };
  const memory = spec ? memoryEstimate(spec) : null;
  const recommendations = spec ? recommendLocalModels(spec, installed) : [];
  const ollamaId = report?.providerId ?? Object.keys(state.saved).find(id => state.saved[id]?.type === 'ollama');

  return (
    <>
      <LightRouting state={state} models={models} route={route} checking={checking} recheck={() => void check()} />

      <CloudFallback state={state} models={models} />

      <div id={RECOMMENDATIONS_ID} className="scroll-mt-12">
        <Section label={t('models_rec')}>
          <div className="space-y-1.5 px-3 py-2.5" data-spec>
            <p className="text-[12px]">
              {browser
                ? t('models_spec_line', [
                    memory ? (memory.certain ? `${memory.gb} GB` : `≥ ${memory.gb} GB`) : '?',
                    browser.cores ? String(browser.cores) : '?',
                    browser.gpu?.vendor || (browser.webgpu ? 'WebGPU' : t('models_spec_noGpu')),
                  ])
                : t('models_checking')}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-[11.5px]">{t('models_spec_memory')}</span>
              <Segmented
                label={t('models_spec_memory')}
                value={memoryChoice}
                onChange={value =>
                  void modelSettingsStore.updateSettings({ localMemoryGb: value ? Number(value) : null })
                }
                options={MEMORY_CHOICES.map(value => ({
                  value,
                  label: value ? `${value} GB` : t('models_spec_memoryAuto'),
                }))}
              />
            </div>
            <p className="text-muted-foreground text-[11px]">{t('models_spec_limits')}</p>
          </div>

          {report && !report.running && (
            <div className="px-3 py-2.5" data-ollama="off">
              <p className="text-[12px]">{t('models_rec_ollamaOff')}</p>
              <CopyCommand command="OLLAMA_ORIGINS='chrome-extension://*' ollama serve" />
            </div>
          )}

          <ul aria-label={t('models_rec')} className="divide-border/60 divide-y">
            {recommendations.map(rec => {
              const installedAs = installed.find(name => baseModelName(name) === baseModelName(rec.name)) ?? rec.name;
              const key = `rec:${rec.name}`;
              const result = test.results[key];
              return (
                <li
                  key={rec.name}
                  className="px-3 py-2.5"
                  data-recommendation={rec.name}
                  data-installed={rec.installed}>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{rec.name}</span>
                    <Badge variant="outline">{t(KIND_LABEL[rec.kind].name)}</Badge>
                    <span className="text-muted-foreground font-mono text-[11px]">
                      {t('models_rec_size', [String(rec.sizeGb)])}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-[11.5px]">{t(KIND_LABEL[rec.kind].why)}</p>
                  {rec.installed ? (
                    <div className="mt-1 flex items-center gap-2">
                      <Badge variant="default">{t('models_rec_installed')}</Badge>
                      <span className="flex-1" />
                      {ollamaId && rec.kind !== 'embed' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={test.busy[key]}
                          onClick={() => void test.run(ollamaId, installedAs, key)}>
                          {test.busy[key] ? t('models_checking') : t('models_test')}
                        </Button>
                      )}
                    </div>
                  ) : (
                    <CopyCommand command={rec.command} />
                  )}
                  {result && (
                    <p
                      role={result.ok ? 'status' : 'alert'}
                      className={cn('mt-0.5 text-[11px]', result.ok ? 'text-muted-foreground' : 'text-destructive')}>
                      {result.ok ? t('models_test_ok', [String(result.ms)]) : result.error}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {report?.running && report.loaded.length > 0 && (
            <p className="text-muted-foreground px-3 py-2 text-[11px]">
              {t('models_rec_loaded', [report.loaded.map(model => model.name).join(', ')])}
            </p>
          )}
        </Section>
      </div>
    </>
  );
}
