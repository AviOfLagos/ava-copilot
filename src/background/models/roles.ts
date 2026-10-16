import {
  agentModelStore,
  db,
  getProviderTypeByProviderId,
  llmProviderStore,
  modelHealthStore,
  modelSettingsStore,
  pickRoleModel,
  speechToTextModelStore,
} from '@extension/storage';
import type { ModelRole, ProviderConfig, RoleChoice } from '@extension/storage';
import { AppError } from '@extension/shared';
import { createChatModel } from '../llm/providers';
import type { ChatModel } from '../llm/types';
import { meterModel } from '../usage/meter';
import type { UsageScope } from '../usage/meter';
import { openHosts } from './breakers';
import { discoveryHost } from './discovery';

/**
 * Every caller asks for a model by role, never by id. `resolveRole` picks one from the user's mapping, the
 * models chosen in other settings, and the registry's catalog, with health: a provider that is down is stood
 * in for (a healthy local model first).
 */

export interface RoleScope {
  workspaceId?: string | null;
  agentId?: string | null;
}

/** Providers whose circuit breaker is open: their host keeps failing right now. */
async function downProviders(providers: Record<string, ProviderConfig>): Promise<Set<string>> {
  const hosts = await openHosts();
  if (hosts.size === 0) return new Set();
  return new Set(
    Object.entries(providers)
      .filter(([providerId, config]) => {
        const host = discoveryHost(config.type ?? getProviderTypeByProviderId(providerId), config.baseUrl);
        return host !== null && hosts.has(host);
      })
      .map(([providerId]) => providerId),
  );
}

/**
 * The model for a role: `{ providerId, model }`, usable with `createChatModel` (see `createRoleModel`).
 * The first automatic embedding model is pinned, so the knowledge base never mixes vectors.
 *
 * @throws AppError not_found when no configured provider can serve the role
 */
export async function resolveRole(role: ModelRole, scope: RoleScope = {}): Promise<RoleChoice> {
  const [providers, catalog, health, settings, agentModels, speechToText] = await Promise.all([
    // Keys are not needed to choose, only whether one is saved
    llmProviderStore.getProviderSummaries(),
    db.modelCatalog.toArray(),
    modelHealthStore.getHealth(),
    modelSettingsStore.getSettings(),
    agentModelStore.getAllAgentModels(),
    speechToTextModelStore.getSpeechToTextModel(),
  ]);
  const choice = pickRoleModel({
    role,
    providers,
    catalog,
    health: health.providers,
    settings,
    agentModels,
    speechToText: speechToText ?? null,
    workspaceId: scope.workspaceId ?? null,
    agentId: scope.agentId ?? null,
    down: await downProviders(providers),
    // Only models the user turned on (Models page); a provider with none chosen offers all it lists
    activeOnly: true,
  });
  if (!choice) {
    throw new AppError('not_found', `No model can do "${role}" work yet. Add a provider in Models & usage.`);
  }
  if (role === 'embed' && !settings.pinnedEmbed && (choice.source === 'auto' || choice.source === 'fallback')) {
    await modelSettingsStore.updateSettings({ pinnedEmbed: { providerId: choice.providerId, model: choice.model } });
  }
  return choice;
}

/**
 * A ready, metered chat model for a role, for callers that generate text (fast, smart, vision, local, search,
 * transcribe). Usage is recorded with the role and the scope's agent, routine, run and workspace.
 */
export async function createRoleModel(
  role: ModelRole,
  scope: UsageScope & RoleScope,
): Promise<{ chatModel: ChatModel; choice: RoleChoice }> {
  const choice = await resolveRole(role, scope);
  // Decrypted here, in the background
  const provider = await llmProviderStore.getProvider(choice.providerId);
  if (!provider) throw new AppError('not_found', `The provider ${choice.providerId} is no longer set up.`);
  const chatModel = meterModel(createChatModel(provider, { provider: choice.providerId, modelName: choice.model }), {
    ...scope,
    role,
  });
  return { chatModel, choice };
}
