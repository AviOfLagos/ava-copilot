import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { getDefaultDisplayNameFromProviderId } from '@extension/storage';
import { cn } from '@extension/ui';
import type { PanelApi } from '../registry';
import CatalogSection from './CatalogSection';
import LocalSection from './LocalSection';
import ProvidersSection from './ProvidersSection';
import RolesSection from './RolesSection';
import SpendSection from './SpendSection';
import UsageSection from './UsageSection';
import { useModelSettings } from './useModelSettings';
import { useProviders } from './useProviders';
import type { ModelsRequest } from './useProviders';

type Tab = 'models' | 'roles' | 'local' | 'usage';

const TABS: { id: Tab; label: Parameters<typeof t>[0] }[] = [
  { id: 'models', label: 'models_tab_models' },
  { id: 'roles', label: 'models_tab_roles' },
  { id: 'local', label: 'models_tab_local' },
  { id: 'usage', label: 'models_tab_usage' },
];

/**
 * The one place for models, in the panel and on the settings page: providers and every model they offer, each
 * with an "active" switch; which active model does each kind of work; local models that fit this computer and
 * where light work goes; spending and usage.
 */
export function ModelsHub({
  request,
  wide = false,
  initialTab,
}: {
  request: ModelsRequest;
  wide?: boolean;
  // A tab to open on (the full-page Settings' #models/local)
  initialTab?: string;
}) {
  const providers = useProviders(request);
  const models = useModelSettings(providers);
  const [tab, setTab] = useState<Tab>(() => TABS.find(item => item.id === initialTab)?.id ?? 'models');
  useEffect(() => {
    const wanted = TABS.find(item => item.id === initialTab)?.id;
    if (wanted) setTab(wanted);
  }, [initialTab]);

  const smart = models.resolve('smart');
  const providerName = (id: string) => providers.saved[id]?.name || getDefaultDisplayNameFromProviderId(id);
  const activeCount = models.active.size;

  return (
    <div
      className={cn('flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-4 pt-2', wide && 'max-w-3xl')}
      data-place="models">
      <p className="text-muted-foreground px-1 text-[11.5px]" data-models-summary>
        {Object.keys(providers.saved).length === 0 && providers.loaded
          ? t('models_summary_none')
          : t('models_summary', [
              String(activeCount),
              smart ? `${providerName(smart.providerId)} · ${smart.model}` : t('models_role_autoNone'),
            ])}
      </p>
      <div
        role="tablist"
        aria-label={t('models_title')}
        className="bg-muted/60 sticky top-0 z-10 grid grid-cols-4 gap-0.5 rounded-full p-0.5 backdrop-blur">
        {TABS.map(item => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`models-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`models-panel-${item.id}`}
            onClick={() => setTab(item.id)}
            className={cn(
              'rounded-full px-2 py-1 text-[12px] transition-colors',
              tab === item.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}>
            {t(item.label)}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`models-panel-${tab}`}
        aria-labelledby={`models-tab-${tab}`}
        className="flex flex-col gap-4">
        {tab === 'models' && (
          <>
            <ProvidersSection state={providers} />
            <CatalogSection state={providers} models={models} />
          </>
        )}
        {tab === 'roles' && <RolesSection state={providers} models={models} />}
        {tab === 'local' && <LocalSection state={providers} models={models} />}
        {tab === 'usage' && (
          <>
            <SpendSection />
            <UsageSection state={providers} />
          </>
        )}
      </div>
    </div>
  );
}

export default function ModelsPage({ api }: { api: PanelApi }) {
  return <ModelsHub request={api.request} />;
}
