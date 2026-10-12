import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { t } from '@extension/i18n';
import { getDefaultDisplayNameFromProviderId, hasTag, TAG } from '@extension/storage';
import type { ModelCatalogEntry } from '@extension/storage';
import { cn } from '@extension/ui';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { formatPrice, formatTokens, HealthDot, inputClass, Section, Segmented, timeAgo } from './ui';
import type { ProvidersState } from './useProviders';

type MessageKey = Parameters<typeof t>[0];

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

function ModelItem({ entry, providerName }: { entry: ModelCatalogEntry; providerName: string }) {
  const caps = CAPABILITIES.filter(cap => hasTag(entry, cap.tag));
  return (
    <li className="px-3 py-2" data-model={entry.id}>
      <div className="flex items-center gap-2">
        <HealthDot status={entry.health} />
        <span className="min-w-0 flex-1 truncate text-[12.5px]" title={entry.model}>
          {entry.label}
        </span>
        <PriceBadge entry={entry} />
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
    </li>
  );
}

export default function CatalogSection({ state }: { state: ProvidersState }) {
  const [search, setSearch] = useState('');
  const [where, setWhere] = useState<'all' | 'local' | 'cloud'>('all');
  const [showAll, setShowAll] = useState(false);
  const [refreshError, setRefreshError] = useState('');

  const names = useMemo(() => {
    const map: Record<string, string> = {};
    for (const [id, config] of Object.entries(state.saved))
      map[id] = config.name || getDefaultDisplayNameFromProviderId(id);
    return map;
  }, [state.saved]);

  const models = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return state.catalog
      .filter(entry => where === 'all' || (where === 'local') === entry.local)
      .filter(
        entry =>
          !needle ||
          entry.model.toLowerCase().includes(needle) ||
          entry.label.toLowerCase().includes(needle) ||
          (names[entry.providerId] ?? '').toLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          (names[a.providerId] ?? a.providerId).localeCompare(names[b.providerId] ?? b.providerId) ||
          a.label.localeCompare(b.label),
      );
  }, [state.catalog, where, search, names]);
  const shown = showAll ? models : models.slice(0, PAGE);
  const lastRefreshAt = state.health.lastRefreshAt;

  const refresh = async () => {
    setRefreshError('');
    try {
      await state.refresh();
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : String(error));
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
        <div className="flex items-center justify-between gap-2">
          <Segmented
            label={t('models_catalog')}
            value={where}
            onChange={setWhere}
            options={[
              { value: 'all', label: t('models_catalog_all') },
              { value: 'local', label: t('models_provider_local') },
              { value: 'cloud', label: t('models_provider_cloud') },
            ]}
          />
          <span className="text-muted-foreground font-mono text-[10.5px]" data-refreshed-at={lastRefreshAt ?? ''}>
            {lastRefreshAt ? t('models_catalog_checked', [timeAgo(lastRefreshAt)]) : t('models_catalog_never')}
          </span>
        </div>
        {refreshError && (
          <p role="alert" className="text-destructive text-[11.5px]">
            {refreshError}
          </p>
        )}
      </div>
      {models.length === 0 ? (
        <p className="text-muted-foreground px-3 py-2.5 text-[12.5px]">{t('models_catalog_empty')}</p>
      ) : (
        <ul aria-label={t('models_catalog')} className="divide-border/60 divide-y">
          {shown.map(entry => (
            <ModelItem key={entry.id} entry={entry} providerName={names[entry.providerId] ?? entry.providerId} />
          ))}
        </ul>
      )}
      {!showAll && models.length > PAGE && (
        <div className="px-3 py-2">
          <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
            {t('models_catalog_more', [String(models.length)])}
          </Button>
        </div>
      )}
    </Section>
  );
}
