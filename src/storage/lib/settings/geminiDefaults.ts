import { AgentNameEnum } from './types';

// Gemini models used when the user has not picked a model for an agent:
// Pro plans, Flash runs the navigation loop (see models/roleDefaults.ts, which assigns them)
export const GEMINI_DEFAULT_AGENT_MODELS: Record<AgentNameEnum, string> = {
  [AgentNameEnum.Planner]: 'gemini-3.1-pro-preview',
  [AgentNameEnum.Navigator]: 'gemini-3.8-flash',
};
