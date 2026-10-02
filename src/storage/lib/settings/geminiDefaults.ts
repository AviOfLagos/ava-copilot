import { agentModelStore } from './agentModels';
import type { ModelConfig } from './agentModels';
import { AgentNameEnum } from './types';

// Gemini models used when the user has not picked a model for an agent:
// Pro plans, Flash runs the navigation loop
export const GEMINI_DEFAULT_AGENT_MODELS: Record<AgentNameEnum, string> = {
  [AgentNameEnum.Planner]: 'gemini-3.1-pro-preview',
  [AgentNameEnum.Navigator]: 'gemini-3.8-flash',
};

/**
 * Assigns the default Gemini models to the agents that have no model yet, so saving a Gemini
 * key is enough to start. An agent the user already configured is left untouched.
 *
 * @param providerId - The id of the saved Gemini provider
 * @param modelNames - The model names the provider offers; a default that is not offered is skipped
 * @returns The models that were assigned, by agent
 */
export async function applyGeminiDefaults(
  providerId: string,
  modelNames: string[],
): Promise<Partial<Record<AgentNameEnum, ModelConfig>>> {
  const assigned: Partial<Record<AgentNameEnum, ModelConfig>> = {};

  for (const agent of Object.values(AgentNameEnum)) {
    const modelName = GEMINI_DEFAULT_AGENT_MODELS[agent];
    if (!modelNames.includes(modelName) || (await agentModelStore.hasAgentModel(agent))) {
      continue;
    }
    const config: ModelConfig = { provider: providerId, modelName };
    await agentModelStore.setAgentModel(agent, config);
    assigned[agent] = config;
  }

  return assigned;
}
