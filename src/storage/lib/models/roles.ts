import { ProviderTypeEnum } from '../settings/types';
import { getProviderTypeByProviderId, isLocalProvider, providerIsUsable } from '../settings/llmProviders';
import type { ProviderConfig } from '../settings/llmProviders';
import type { ModelConfig } from '../settings/agentModels';
import { activeModelIds, modelKey } from './active';
import { fitsRole, scoreForRole, tagsFromName, TAG, withTags } from './capabilities';
import type { ProviderHealth } from './health';
import type { ModelSettingsRecord, RoleTarget } from './settings';
import type { ModelCatalogEntry, ModelRole } from './types';

/**
 * Which model serves a role: the pure part of `resolveRole`, shared by the background (which calls the model)
 * and the Models page (which shows what "Automatic" means right now). No storage, no network.
 */

// Where the choice came from: a mapping for the agent, the workspace or everyone; the pinned embedding model;
// a model chosen in another setting (an agent model, speech-to-text); the registry's best; or, before the
// registry has listed anything, the models saved with a provider
export type RoleSource = 'agent' | 'workspace' | 'user' | 'pinned' | 'setting' | 'auto' | 'fallback';

export interface RoleChoice extends RoleTarget {
  source: RoleSource;
  local: boolean;
  // A provider that was asked for is down, and this one stands in for it
  standIn?: boolean;
}

export interface RoleInputs {
  role: ModelRole;
  // Provider settings; keys are not needed, only whether one is saved
  providers: Record<string, ProviderConfig>;
  catalog: ModelCatalogEntry[];
  health: Record<string, ProviderHealth>;
  settings: ModelSettingsRecord;
  agentModels?: Partial<Record<'planner' | 'navigator', ModelConfig>>;
  speechToText?: { provider: string; modelName: string } | null;
  workspaceId?: string | null;
  agentId?: string | null;
  // Providers whose circuit breaker is open right now
  down?: Set<string>;
  // Pick only from active models (./active.ts); the pinned embedding model is kept either way
  activeOnly?: boolean;
}

/** Tags a provider's kind adds to a model's own: every Gemini chat model can search with Google and hear audio. */
export function providerTags(type: ProviderTypeEnum | undefined, tags: string[]): string[] {
  if (type === ProviderTypeEnum.Gemini && tags.includes(TAG.chat)) {
    return withTags(tags, TAG.search, TAG.image, TAG.audio, TAG.video);
  }
  if (type === ProviderTypeEnum.Anthropic && tags.includes(TAG.chat)) return withTags(tags, TAG.image);
  return tags;
}

function typeOf(providers: Record<string, ProviderConfig>, providerId: string): ProviderTypeEnum {
  return providers[providerId]?.type ?? getProviderTypeByProviderId(providerId);
}

/** Entries made from the model names saved with providers the registry has not listed yet. */
export function savedModelEntries(
  providers: Record<string, ProviderConfig>,
  catalog: ModelCatalogEntry[],
): ModelCatalogEntry[] {
  const listed = new Set(catalog.map(entry => entry.providerId));
  const entries: ModelCatalogEntry[] = [];
  for (const [providerId, config] of Object.entries(providers)) {
    if (listed.has(providerId)) continue;
    const type = typeOf(providers, providerId);
    const names =
      type === ProviderTypeEnum.AzureOpenAI ? (config.azureDeploymentNames ?? []) : (config.modelNames ?? []);
    const local = isLocalProvider({ ...config, type });
    for (const model of names) {
      entries.push({
        id: `${providerId}:${model}`,
        providerId,
        model,
        label: model,
        local,
        contextTokens: null,
        inputUsdPerM: local ? 0 : null,
        outputUsdPerM: local ? 0 : null,
        modalities: providerTags(type, tagsFromName(model)),
        tools: null,
        health: 'unknown',
        seenAt: 0,
      });
    }
  }
  return entries;
}

/** The explicit mapping that applies: the agent's, then the workspace's, then everyone's. */
function mappedTarget(inputs: RoleInputs): { target: RoleTarget; source: RoleSource } | null {
  const { role, settings } = inputs;
  const agent = inputs.agentId ? settings.agentRoles?.[inputs.agentId]?.[role] : undefined;
  if (agent) return { target: agent, source: 'agent' };
  const workspace = inputs.workspaceId ? settings.workspaceRoles?.[inputs.workspaceId]?.[role] : undefined;
  if (workspace) return { target: workspace, source: 'workspace' };
  const everyone = settings.roles?.[role];
  if (everyone) return { target: everyone, source: 'user' };
  if (role === 'embed' && settings.pinnedEmbed) return { target: settings.pinnedEmbed, source: 'pinned' };
  return null;
}

/** A model the user already chose in another setting: the Planner for smart work, the Navigator for fast. */
function settingTarget(inputs: RoleInputs): RoleTarget | null {
  const pick = (config?: { provider: string; modelName: string } | null) =>
    config ? { providerId: config.provider, model: config.modelName } : null;
  switch (inputs.role) {
    case 'smart':
      return pick(inputs.agentModels?.planner);
    case 'fast':
      return pick(inputs.agentModels?.navigator);
    case 'transcribe':
      return pick(inputs.speechToText);
    default:
      return null;
  }
}

/**
 * The model for a role, or null when nothing configured can serve it.
 * 1. A mapping the user made (agent, then workspace, then everyone; the pinned embedding model).
 * 2. A model chosen in another setting (Planner → smart, Navigator → fast, speech-to-text → transcribe).
 * 3. The best model the registry found, by capability, health and a score (see `scoreForRole`).
 * A chosen provider that is down is stood in for by a healthy local model if there is one, else by the best
 * healthy model elsewhere; the embedding model is never swapped, since its vectors would no longer match.
 */
export function pickRoleModel(inputs: RoleInputs): RoleChoice | null {
  const { role, providers, health } = inputs;
  const down = inputs.down ?? new Set<string>();
  const usable = (providerId: string) => providerIsUsable(providers[providerId], providerId);
  const isDown = (providerId: string) => down.has(providerId) || health[providerId]?.status === 'error';
  const isLocal = (providerId: string) =>
    Boolean(providers[providerId]) &&
    isLocalProvider({ ...providers[providerId], type: typeOf(providers, providerId) });
  const choose = (target: RoleTarget, source: RoleSource, standIn = false): RoleChoice => ({
    providerId: target.providerId,
    model: target.model,
    source,
    local: isLocal(target.providerId),
    ...(standIn ? { standIn } : {}),
  });

  // Every model that can do the role, best first
  const fromCatalog = inputs.catalog.filter(entry => usable(entry.providerId));
  const saved = savedModelEntries(
    Object.fromEntries(Object.entries(providers).filter(([providerId]) => usable(providerId))),
    inputs.catalog,
  );
  const preferred = new Set<string>();
  for (const [providerId, config] of Object.entries(providers)) {
    for (const name of config.modelNames ?? []) preferred.add(`${providerId}:${name}`);
  }
  const agentConfigs = Object.values(inputs.agentModels ?? {}).filter((config): config is ModelConfig => !!config);
  for (const config of agentConfigs) preferred.add(`${config.provider}:${config.modelName}`);
  const context = { preferred, agentProviders: new Set(agentConfigs.map(config => config.provider)) };
  const active = inputs.activeOnly ? activeModelIds(providers, inputs.catalog) : null;
  const isActive = (target: RoleTarget) => !active || active.has(modelKey(target.providerId, target.model));
  const ranked = [...fromCatalog, ...saved]
    .filter(entry => fitsRole(entry, role) && isActive(entry))
    .map(entry => ({ entry, score: scoreForRole(entry, role, context) }))
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .map(({ entry }) => entry);
  const healthy = ranked.filter(entry => entry.health !== 'error' && !isDown(entry.providerId));

  const standInFor = (providerId: string): RoleChoice | null => {
    if (role === 'embed' || role === 'local') return null;
    const others = healthy.filter(entry => entry.providerId !== providerId);
    const replacement = others.find(entry => entry.local) ?? others[0];
    if (!replacement) return null;
    return choose(replacement, replacement.seenAt ? 'auto' : 'fallback', true);
  };

  const mapped = mappedTarget(inputs);
  if (mapped && usable(mapped.target.providerId) && (isActive(mapped.target) || mapped.source === 'pinned')) {
    if (!isDown(mapped.target.providerId) || role === 'embed') return choose(mapped.target, mapped.source);
    return standInFor(mapped.target.providerId) ?? choose(mapped.target, mapped.source);
  }

  const setting = settingTarget(inputs);
  if (setting && usable(setting.providerId) && isActive(setting)) {
    if (!isDown(setting.providerId)) return choose(setting, 'setting');
    return standInFor(setting.providerId) ?? choose(setting, 'setting');
  }

  const best = healthy[0] ?? ranked[0];
  if (!best) return null;
  return choose(best, best.seenAt ? 'auto' : 'fallback');
}
