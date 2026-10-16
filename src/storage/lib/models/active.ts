import { ProviderTypeEnum } from '../settings/types';
import { getProviderTypeByProviderId } from '../settings/llmProviders';
import type { ProviderConfig } from '../settings/llmProviders';
import { fitsRole, hasTag, scoreForRole, TAG } from './capabilities';
import type { ModelCatalogEntry, ModelRole } from './types';

/**
 * Which models are turned on ("active"). A provider's saved model names are its active models, the same list the
 * settings page used to edit as "Models"; a provider with none saved offers everything it lists (until the
 * registry's first refresh turns on a sensible few, see `defaultActiveModels`). Roles pick from active models only.
 */

export const modelKey = (providerId: string, model: string): string => `${providerId}:${model}`;

/** The names saved with a provider: Azure's deployments, else its model names. */
export function savedNames(providerId: string, config: ProviderConfig | undefined): string[] {
  if (!config) return [];
  const type = config.type ?? getProviderTypeByProviderId(providerId);
  return (type === ProviderTypeEnum.AzureOpenAI ? config.azureDeploymentNames : config.modelNames) ?? [];
}

/** Every active model, as "<providerId>:<model>". */
export function activeModelIds(providers: Record<string, ProviderConfig>, catalog: ModelCatalogEntry[]): Set<string> {
  const active = new Set<string>();
  for (const [providerId, config] of Object.entries(providers)) {
    const names = savedNames(providerId, config);
    if (names.length) {
      for (const name of names) active.add(modelKey(providerId, name));
    } else {
      for (const entry of catalog) if (entry.providerId === providerId) active.add(entry.id);
    }
  }
  return active;
}

// The roles a cloud provider's first models are chosen for, in order
const DEFAULT_ROLES: ModelRole[] = ['fast', 'smart', 'vision', 'embed', 'transcribe', 'search'];
const MAX_LOCAL_DEFAULTS = 20;

/**
 * The models to turn on for a provider the registry has just listed, when the user has chosen none: every local
 * chat or embedding model (they are installed on purpose, and free), or a cloud provider's best model for each kind
 * of work. Returns model names.
 */
export function defaultActiveModels(entries: ModelCatalogEntry[], local: boolean): string[] {
  if (local) {
    return entries
      .filter(entry => hasTag(entry, TAG.chat) || hasTag(entry, TAG.embedding))
      .map(entry => entry.model)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_LOCAL_DEFAULTS);
  }
  const context = { preferred: new Set<string>(), agentProviders: new Set<string>() };
  const chosen: string[] = [];
  for (const role of DEFAULT_ROLES) {
    const best = entries
      .filter(entry => fitsRole(entry, role))
      .map(entry => ({ entry, score: scoreForRole(entry, role, context) }))
      .sort((a, b) => b.score - a.score || a.entry.model.localeCompare(b.entry.model))[0];
    if (best && !chosen.includes(best.entry.model)) chosen.push(best.entry.model);
  }
  return chosen;
}

/**
 * A provider's model names after turning one model on or off. Off works on what is active now (everything
 * listed, when none are saved). Returns null when it would leave the provider with no active model: an empty list
 * means "all of them", so the last one stays on (remove the provider instead).
 */
export function withModelActive(names: string[], listed: string[], model: string, on: boolean): string[] | null {
  const current = names.length ? names : listed;
  if (on) return current.includes(model) ? names : [...current, model];
  const next = current.filter(name => name !== model);
  return next.length ? next : null;
}
