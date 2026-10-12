import type { PanelApi } from '../registry';
import CatalogSection from './CatalogSection';
import ProvidersSection from './ProvidersSection';
import RolesSection from './RolesSection';
import SpendSection from './SpendSection';
import UsageSection from './UsageSection';
import { useProviders } from './useProviders';

/**
 * Models & usage: providers and their keys (masked; saved, checked and removed through the background), the
 * models every provider offers, which model each kind of work uses, spending against the caps, and usage by
 * day, model, agent, routine and workspace.
 */
export default function ModelsPage({ api }: { api: PanelApi }) {
  const providers = useProviders(api.request);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-4 pt-2" data-place="models">
      <SpendSection />
      <ProvidersSection state={providers} />
      <CatalogSection state={providers} />
      <RolesSection state={providers} />
      <UsageSection state={providers} />
    </div>
  );
}
