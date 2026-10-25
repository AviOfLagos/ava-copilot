import { AppError } from '@extension/shared';
import { db as defaultDb } from '@extension/storage';
import type { AgentProfile, AviCopilotDb } from '@extension/storage';
import { findAgent } from '../agents/service';
import { isDraftAgent } from '../agents/profile';
import { brainSettingsStore } from '../companion/state';
import { connectorService } from '../integrations/instance';
import type { ConnectorService } from '../integrations/service';
import { stepScope, toolStepArgs } from '../integrations/step';
import type { StepExecutor } from './engine';
import type { NodeOf, NodeType } from './spec';

/**
 * What a step that acts for the user needs before it can run at all, checked before the user is asked to allow it
 * (see StepExecutor.check): Ava Brain paired for a sandbox step, the named agent for an agent step, the connector
 * and its tool for a tool step. Without these the user would click Allow only to see the step fail.
 */

export const NEEDS_NEX_BRAIN =
  'This step runs code in Ava Brain, the companion app on your Mac, and this browser is not paired with it. Pair it in Settings › Ava Brain, then run the routine again.';

export interface PrecheckDeps {
  brainPaired: () => Promise<boolean>;
  agents: () => Promise<AgentProfile[]>;
  connectors: Pick<ConnectorService, 'prepare'>;
  database: AviCopilotDb;
}

const defaultDeps = (): PrecheckDeps => ({
  brainPaired: async () => (await brainSettingsStore.getSettings()).paired,
  agents: () => defaultDb.agents.toArray(),
  connectors: connectorService,
  database: defaultDb,
});

export function prechecksFor(deps: PrecheckDeps = defaultDeps()): Partial<Record<NodeType, StepExecutor['check']>> {
  return {
    'step.sandbox': async () => {
      if (!(await deps.brainPaired())) throw new AppError('unavailable', NEEDS_NEX_BRAIN, { retryable: false });
    },
    'step.agent': async ({ params, workflow }) => {
      const node = params as unknown as NodeOf<'step.agent'>;
      const name = node.agent?.trim();
      if (!name) {
        throw new AppError('invalid', 'This step names no agent: set the name of one of your agents on it.', {
          retryable: false,
        });
      }
      const agents = (await deps.agents()).filter(
        agent =>
          !isDraftAgent(agent) &&
          (!agent.workspaceId || !workflow.workspaceId || agent.workspaceId === workflow.workspaceId),
      );
      if (!findAgent(agents, name)) {
        throw new AppError(
          'not_found',
          `There is no agent "${name}"${agents.length ? `; your agents: ${agents.map(agent => `"${agent.name}"`).join(', ')}` : ''}. Create it in Agents or change the step.`,
          { retryable: false },
        );
      }
    },
    'step.tool': async ({ node, run, workflow }) => {
      if (node.type !== 'step.tool') return;
      const args = await toolStepArgs(node.args, () => stepScope(run, workflow, deps.database));
      const scope = {
        workspaceId: run.workspaceId ?? workflow.workspaceId ?? null,
        agentId: run.agentId ?? workflow.agentId ?? null,
      };
      const prepared = await deps.connectors.prepare(scope, node.connector, node.tool, args);
      if ('refused' in prepared) {
        const message = !prepared.refused.startsWith('This chat is in no workspace')
          ? prepared.refused
          : 'This routine is in no workspace, and connectors belong to workspaces: draft it again from a chat in a workspace that has this connector.';
        throw new AppError('forbidden', message, { retryable: false });
      }
    },
  };
}

let defaults: Partial<Record<NodeType, StepExecutor['check']>> | null = null;

/** The check for a kind of step, when it has one (built on first use, so nothing is read at import time). */
export function precheckFor(type: NodeType): StepExecutor['check'] {
  defaults ??= prechecksFor();
  return defaults[type];
}
