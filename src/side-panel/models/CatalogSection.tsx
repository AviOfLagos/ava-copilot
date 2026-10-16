import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { t } from '@extension/i18n';
import {
  getDefaultDisplayNameFromProviderId,
  getProviderTypeByProviderId,
  hasTag,
  llmProviderStore,
  MODEL_ROLES,
  modelKey,
  modelSettingsStore,
  ProviderTypeEnum,
  savedModelEntries,
  savedNames,
  TAG,
  withModelActive,
} from '@extension/storage';
import type { ModelCatalogEntry, ModelRole } from '@extension/storage';
import { cn } from '@extension/ui';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { ROLE_LABELS } from './roleLabels';
import { formatPrice, formatTokens, HealthDot, inputClass, Section, Segmented, timeAgo } from './ui';
import type { ModelSettingsState } from './useModelSettings';
import type { ProvidersState } from './useProviders';
import { useModelTest } from './useModelTest';

type MessageKey = Parameters<typeof t>[0];
type Filter = 'all' | 'active' | 'local' | 'cloud';

const PAGE = 30;

const CAPABILITIES: { tag: string; label: MessageKey }[] = [
  { tag: TAG.image, label: 'models_cap_vision' },
  { tag: TAG.audio, label: 'models_cap_audio' },
  { tag: TAG.embedding, label: 'models_cap_embed' },
  { tag: TAG.live, label: 'models_cap_live' },
  { tag: TAG.speech, label: 'models_cap_speech' },
  { tag: TAG.search, label: 'models_cap_search' },
  { tag: TAG.reasoning, label: 'models_cap_reasoning' },
];

function PriceBadge({ entry }: { entry: ModelCatalogEntry }) {
  if (entry.local || (entry.inputUsdPerM === 0 && entry.outputUsdPerM === 0)) {
    return <Badge variant="default">{t('models_price_free')}</Badge>;
  }
  if (entry.inputUsdPerM === null || entry.outputUsdPerM === null) {
    return <Badge variant="outline">{t('models_price_unknown')}</Badge>;
  }
  return (
    <Badge variant="secondary" title={t('models_price_title')}>
      {formatPrice(entry.inputUsdPerM)} / {formatPrice(entry.outputUsdPerM)}
    </Badge>
  );
}

interface ItemProps {
  entry: ModelCatalogEntry;
  providerName: string;
  active: boolean;
  // Roles this model serves now
  roles: ModelRole[];
  // Why it cannot be turned off, or null
  locked: string | null;
  onToggle: (on: boolean) => void;
  test: ReturnType<typeof useModelTest>;
}

function ModelItem({ entry, providerName, active, roles, locked, onToggle, test }: ItemProps) {
  const caps = CAPABILITIES.filter(cap => hasTag(entry, cap.tag));
  const result = test.results[entry.id];
  return (
    <li className={cn('px-3 py-2', !active && 'opacity-70')} data-model={entry.id} data-active={active}>
      <div className="flex items-center gap-2">
        <HealthDot status={entry.health} />
        <span className="min-w-0 flex-1 truncate text-[12.5px]" title={entry.model}>
          {entry.label}
        </span>
        <PriceBadge entry={entry} />
        <span title={locked ?? undefined}>
          <Switch
            checked={active}
            disabled={Boolean(locked) && active}
            label={t(active ? 'models_active_off' : 'models_active_on', [entry.label])}
            onChange={onToggle}
          />
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1 pl-4">
        <span className="text-muted-foreground max-w-[45%] truncate font-mono text-[10.5px]">{providerName}</span>
        <Badge variant={entry.local ? 'default' : 'outline'}>
          {entry.local ? t('models_provider_local') : t('models_provider_cloud')}
        </Badge>
        {entry.contextTokens !== null && (
          <Badge variant="outline">{t('models_context', [formatTokens(entry.contextTokens)])}</Badge>
        )}
        {entry.tools === true && <Badge variant="outline">{t('models_cap_tools')}</Badge>}
        {caps.map(cap => (
          <Badge key={cap.tag} variant="outline">
            {t(cap.label)}
          </Badge>
        ))}
      </div>
      {(roles.length > 0 || (active && hasTag(entry, TAG.chat))) && (
        <div className="mt-1 flex flex-wrap items-center gap-1 pl-4">
          {roles.map(role => (
            <span
              key={role}
              data-serves={role}
              className="border-primary/40 text-foreground rounded-full border px-1.5 py-px text-[10.5px]">
              {t(ROLE_LABELS[role].name)}
            </span>
          ))}
          <span className="flex-1" />
          {active && hasTag(entry, TAG.chat) && (
            <Button
              size="sm"
              variant="ghost"
              disabled={test.busy[entry.id]}
              onClick={() => void test.run(entry.providerId, entry.model, entry.id)}>
              {test.busy[entry.id] ? t('models_checking') : t('models_test')}
            </Button>
          )}
        </div>
      )}
      {result && (
        <p
          role={result.ok ? 'status' : 'alert'}
          className={cn('mt-0.5 pl-4 text-[11px]', result.ok ? 'text-muted-foreground' : 'text-destructive')}>
          {result.ok ? t('models_test_ok', [String(result.ms)]) : result.error}
        </p>
      )}
    </li>
  );
}

/**
 * Every model the providers offer, with a switch for each: active models are the ones roles may use. A provider
 * with none chosen offers everything it lists; the registry turns on a sensible few the first time it lists one.
 */
export default function CatalogSection({ state, models }: { state: ProvidersState; models: ModelSettingsState }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [showAll, setShowAll] = useState(false);
  const [message, setMessage] = useState('');
  const test = useModelTest(state);

  const names = useMemo(() => {
    const map: Record<string, string> = {};
    for (const [id, config] of Object.entries(state.saved))
      map[id] = config.name || getDefaultDisplayNameFromProviderId(id);
    return map;
  }, [state.saved]);

  // Listed models, and models saved with a provider the registry has not listed
  const all = useMemo(
    () => [
      ...state.catalog.filter(entry => entry.providerId in state.saved),
      ...savedModelEntries(state.saved, state.catalog),
    ],
    [state.catalog, state.saved],
  );

  // Which roles each model serves now, and which ones must stay on
  const serving = useMemo(() => {
    const map = new Map<string, ModelRole[]>();
    for (const role of MODEL_ROLES) {
      const choice = models.resolve(role);
      if (!choice) continue;
      const id = modelKey(choice.providerId, choice.model);
      map.set(id, [...(map.get(id) ?? []), role]);
    }
    return map;
  }, [models]);
  const lockedReason = (entry: ModelCatalogEntry): string | null => {
    const id = entry.id;
    const agents = models.agentModels;
    if (agents.planner && modelKey(agents.planner.provider, agents.planner.modelName) === id) {
      return t('models_active_locked', [t('models_role_smart')]);
    }
    if (agents.navigator && modelKey(agents.navigator.provider, agents.navigator.modelName) === id) {
      return t('models_active_locked', [t('models_role_fast')]);
    }
    const pinned = models.settings.pinnedEmbed;
    if (pinned && modelKey(pinned.providerId, pinned.model) === id) {
      return t('models_active_locked', [t('models_role_embed')]);
    }
    return null;
  };

  const shownModels = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return all
      .filter(entry =>
        filter === 'active' ? models.active.has(entry.id) : filter === 'all' || (filter === 'local') === entry.local,
      )
      .filter(
        entry =>
          !needle ||
          entry.model.toLowerCase().includes(needle) ||
          entry.label.toLowerCase().includes(needle) ||
          (names[entry.providerId] ?? '').toLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          Number(models.active.has(b.id)) - Number(models.active.has(a.id)) ||
          Number(b.local) - Number(a.local) ||
          (names[a.providerId] ?? a.providerId).localeCompare(names[b.providerId] ?? b.providerId) ||
          a.label.localeCompare(b.label),
      );
  }, [all, filter, search, names, models.active]);
  const shown = showAll ? shownModels : shownModels.slice(0, PAGE);
  const lastRefreshAt = state.health.lastRefreshAt;
  const activeCount = all.filter(entry => models.active.has(entry.id)).length;

  const toggle = async (entry: ModelCatalogEntry, on: boolean) => {
    setMessage('');
    const config = state.saved[entry.providerId];
    if (!config) return;
    if ((config.type ?? getProviderTypeByProviderId(entry.providerId)) === ProviderTypeEnum.AzureOpenAI) {
      setMessage(t('models_active_azure'));
      return;
    }
    const listed = state.catalog.filter(item => item.providerId === entry.providerId).map(item => item.model);
    const next = withModelActive(savedNames(entry.providerId, config), listed, entry.model, on);
    if (!next) {
      setMessage(t('models_active_lastOne', [names[entry.providerId] ?? entry.providerId]));
      return;
    }
    await llmProviderStore.setModelNames(entry.providerId, next);
    if (!on) {
      // A role set to a model turned off goes back to Automatic
      for (const [role, target] of Object.entries(models.settings.roles)) {
        if (target && modelKey(target.providerId, target.model) === entry.id) {
          await modelSettingsStore.setRole(role as ModelRole, null);
        }
      }
    }
  };

  const refresh = async () => {
    setMessage('');
    try {
      await state.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Section
      label={t('models_catalog')}
      action={
        <Button
          size="sm"
          variant="ghost"
          disabled={state.refreshing}
          aria-label={state.refreshing ? t('models_catalog_refreshing') : t('models_catalog_refresh')}
          onClick={() => void refresh()}>
          <RefreshCw className={cn('size-3.5', state.refreshing && 'animate-spin motion-reduce:animate-none')} />
          {state.refreshing ? t('models_catalog_refreshing') : t('models_catalog_refresh')}
        </Button>
      }>
      <div className="space-y-2 px-3 py-2.5">
        <p className="text-muted-foreground text-[11.5px]">
          {t('models_active_hint', [String(activeCount), String(all.length)])}
        </p>
        <label htmlFor="models-catalog-search" className="sr-only">
          {t('models_catalog_search')}
        </label>
        <input
          id="models-catalog-search"
          type="search"
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder={t('models_catalog_search')}
          className={inputClass}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented
            label={t('models_catalog_filter')}
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: t('models_catalog_all') },
              { value: 'active', label: t('models_catalog_active') },
              { value: 'local', label: t('models_provider_local') },
              { value: 'cloud', label: t('models_provider_cloud') },
            ]}
          />
          <span className="text-muted-foreground font-mono text-[10.5px]" data-refreshed-at={lastRefreshAt ?? ''}>
            {lastRefreshAt ? t('models_catalog_checked', [timeAgo(lastRefreshAt)]) : t('models_catalog_never')}
          </span>
        </div>
        {message && (
          <p role="alert" className="text-destructive text-[11.5px]">
            {message}
          </p>
        )}
      </div>
      {shownModels.length === 0 ? (
        <p className="text-muted-foreground px-3 py-2.5 text-[12.5px]" data-empty="catalog">
          {Object.keys(state.saved).length === 0
            ? t('models_catalog_emptyNoProvider')
            : filter === 'local'
              ? t('models_catalog_emptyLocal')
              : t('models_catalog_empty')}
        </p>
      ) : (
        <ul aria-label={t('models_catalog')} className="divide-border/60 divide-y">
          {shown.map(entry => (
            <ModelItem
              key={entry.id}
              entry={entry}
              providerName={names[entry.providerId] ?? entry.providerId}
              active={models.active.has(entry.id)}
              roles={serving.get(entry.id) ?? []}
              locked={lockedReason(entry)}
              onToggle={on => void toggle(entry, on)}
              test={test}
            />
          ))}
        </ul>
      )}
      {!showAll && shownModels.length > PAGE && (
        <div className="px-3 py-2">
          <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
            {t('models_catalog_more', [String(shownModels.length)])}
          </Button>
        </div>
      )}
    </Section>
  );
}
