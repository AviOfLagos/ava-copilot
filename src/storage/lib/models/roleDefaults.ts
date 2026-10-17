import { agentModelStore } from '../settings/agentModels';
import type { ModelConfig } from '../settings/agentModels';
import { GEMINI_DEFAULT_AGENT_MODELS } from '../settings/geminiDefaults';
import { llmProviderStore, providerIsUsable } from '../settings/llmProviders';
import { AgentNameEnum, ProviderTypeEnum } from '../settings/types';
import { fitsRole, scoreForRole } from './capabilities';
import { modelSettingsStore } from './settings';
import type { RoleTarget } from './settings';
import type { ModelCatalogEntry } from './types';

/**
 * The models a provider that was just set up gives the Planner and the Navigator (and the smart and fast roles)
 * when nothing usable is chosen for them yet, so one working key or one local server is enough to start.
 */

export interface RoleDefaults {
  // For the Planner and the smart role
  smart: string | null;
  // For the Navigator and the fast role
  fast: string | null;
}

export interface RoleDefaultsOptions {
  type: ProviderTypeEnum;
  local: boolean;
}

const NO_PREFERENCE = { preferred: new Set<string>(), agentProviders: new Set<string>() };

function best(entries: ModelCatalogEntry[], role: 'smart' | 'fast'): string | null {
  const ranked = entries
    .filter(entry => fitsRole(entry, role))
    .map(entry => ({ entry, score: scoreForRole(entry, role, NO_PREFERENCE) }))
    .sort((a, b) => b.score - a.score || a.entry.model.localeCompare(b.entry.model));
  return ranked[0]?.entry.model ?? null;
}

/**
 * Which of a provider's active models does smart and fast work. A cloud provider gives its best model for each
 * (Gemini its own pair when offered); a local server gives one chat model for both, since two would compete for
 * the computer's memory. Pure: `entries` are the provider's active models.
 */
export function pickRoleDefaults(entries: ModelCatalogEntry[], options: RoleDefaultsOptions): RoleDefaults {
  const names = new Set(entries.map(entry => entry.model));
  if (options.local) {
    const model = best(entries, 'smart');
    return { smart: model, fast: model };
  }
  const gemini = options.type === ProviderTypeEnum.Gemini;
  const plannerDefault = GEMINI_DEFAULT_AGENT_MODELS[AgentNameEnum.Planner];
  const navigatorDefault = GEMINI_DEFAULT_AGENT_MODELS[AgentNameEnum.Navigator];
  return {
    smart: gemini && names.has(plannerDefault) ? plannerDefault : best(entries, 'smart'),
    fast: gemini && names.has(navigatorDefault) ? navigatorDefault : best(entries, 'fast'),
  };
}

export interface AppliedDefaults {
  agents: Partial<Record<AgentNameEnum, ModelConfig>>;
  roles: Partial<Record<'smart' | 'fast', RoleTarget>>;
}

const AGENT_ROLE = { [AgentNameEnum.Planner]: 'smart', [AgentNameEnum.Navigator]: 'fast' } as const;

/**
 * Gives the Planner and the Navigator this provider's defaults where they have no model, or one whose provider is
 * gone or can no longer be called (its key was removed). A working choice the user made is never changed. The
 * smart and fast roles follow an agent that was given a default, unless the user mapped them already.
 *
 * @returns What was written
 */
export async function applyRoleDefaults(
  providerId: string,
  entries: ModelCatalogEntry[],
  options: RoleDefaultsOptions,
): Promise<AppliedDefaults> {
  const applied: AppliedDefaults = { agents: {}, roles: {} };
  const defaults = pickRoleDefaults(entries, options);
  if (!defaults.smart && !defaults.fast) return applied;

  const [providers, agents, settings] = await Promise.all([
    llmProviderStore.getProviderSummaries(),
    agentModelStore.getAllAgentModels(),
    modelSettingsStore.getSettings(),
  ]);
  const works = (id: string | undefined) => Boolean(id && providerIsUsable(providers[id], id));

  for (const agent of [AgentNameEnum.Planner, AgentNameEnum.Navigator]) {
    const role = AGENT_ROLE[agent];
    const model = defaults[role];
    if (!model || works(agents[agent]?.provider)) continue;
    const config: ModelConfig = { provider: providerId, modelName: model };
    await agentModelStore.setAgentModel(agent, config);
    applied.agents[agent] = config;
    const mapped = settings.roles?.[role];
    if (!mapped || !works(mapped.providerId)) {
      const target = { providerId, model };
      await modelSettingsStore.setRole(role, target);
      applied.roles[role] = target;
    }
  }
  return applied;
}
