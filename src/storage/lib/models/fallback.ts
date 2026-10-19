import { providerIsUsable } from '../settings/llmProviders';
import { fitsRole } from './capabilities';
import { pickRoleModel, savedModelEntries } from './roles';
import type { RoleChoice, RoleInputs } from './roles';
import type { ModelCatalogEntry } from './types';

/**
 * The local model a failed cloud call is tried again on (setting `fallbackLocal`), shared by the background,
 * which switches models, and the Models page, which shows what "Automatic" means now. No storage, no network.
 */

export type FallbackInputs = Pick<RoleInputs, 'providers' | 'catalog' | 'health' | 'settings' | 'activeOnly'>;

/** Every local chat model a usable provider offers, from the registry or from the names saved with it. */
export function localChatModels(inputs: Pick<RoleInputs, 'providers' | 'catalog'>): ModelCatalogEntry[] {
  const usable = Object.fromEntries(
    Object.entries(inputs.providers).filter(([providerId, config]) => providerIsUsable(config, providerId)),
  );
  return [
    ...inputs.catalog.filter(entry => entry.providerId in usable),
    ...savedModelEntries(usable, inputs.catalog),
  ].filter(entry => fitsRole(entry, 'local'));
}

/**
 * The model to fall back on, or null when the setting is off or no local chat model is found: the chosen one
 * while it is still found, otherwise the best local model (the `local` role's pick).
 */
export function pickFallbackModel(inputs: FallbackInputs, { ignoreEnabled = false } = {}): RoleChoice | null {
  const setting = inputs.settings.fallbackLocal;
  if (!setting?.enabled && !ignoreEnabled) return null;
  const chosen = setting?.model;
  if (
    chosen &&
    localChatModels(inputs).some(entry => entry.providerId === chosen.providerId && entry.model === chosen.model)
  ) {
    return { providerId: chosen.providerId, model: chosen.model, source: 'user', local: true };
  }
  const best = pickRoleModel({ ...inputs, role: 'local' });
  return best?.local ? best : null;
}
