import { db } from '@extension/storage';
import type { AgentProfile } from '@extension/storage';
import type { AgentContext } from '../agent/types';
import { callerOf } from '../integrations/caller';
import { createLogger } from '../log';
import { isDraftAgent, ownsWork } from './profile';

/**
 * What a chat is told about its team: the agents of its workspace and what they own, in the [Your agents] block of
 * each step's browser state (agent/prompts/base.ts). Light on purpose: the prompt imports it.
 */

const logger = createLogger('Agents');
const MAX_TEAM_LINES = 12;

/**
 * The agents a chat may hand to: created ones in its workspace, and those in none. A chat in no workspace sees only
 * the agents in none, so a workspace's agents never take work from outside it.
 */
export function teamOf(agents: readonly AgentProfile[], workspaceId: string | null): AgentProfile[] {
  return agents.filter(agent => !isDraftAgent(agent) && (!agent.workspaceId || agent.workspaceId === workspaceId));
}

/** One line per agent of the team that owns something, for refusals and the prompt. */
export function teamLines(team: readonly AgentProfile[]): string[] {
  return team
    .filter(agent => ownsWork(agent) && agent.owns?.length)
    .slice(0, MAX_TEAM_LINES)
    .map(agent => `- "${agent.name}" owns ${agent.owns!.join(', ')}${agent.charter ? `: ${agent.charter}` : ''}`);
}

/** The block a chat's step is given: its agents and what they own, and when to hand work to them. */
export function teamSection(team: readonly AgentProfile[]): string {
  const lines = teamLines(team);
  if (!lines.length) return '';
  return `\n[Your agents]\nThe user's agents in this chat's workspace and the areas of work they own:\n${lines.join('\n')}\nWhen the user's request is in one of these areas, or names one of these agents, hand it over with hand_to_agent (the area or the agent, and the task in the user's words) instead of doing it yourself, unless the user asks you to do it here. Then say in one line that it was handed over, and finish.\n`;
}

/** The [Your agents] block of a chat's step: '' for chats the user is not in, and when no agent owns anything. */
export async function teamSectionFor(context: Pick<AgentContext, 'taskId'>): Promise<string> {
  try {
    const { scope, attended } = await callerOf(context);
    if (!attended || scope.agentId) return '';
    return teamSection(teamOf(await db.agents.toArray(), scope.workspaceId));
  } catch (error) {
    logger.warning('Could not list the team', error);
    return '';
  }
}
