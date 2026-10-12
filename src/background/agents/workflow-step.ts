import { AppError } from '@extension/shared';
import type { AgentTaskState, AviCopilotDb } from '@extension/storage';
import type { StepExecutor } from '../workflows/engine';
import type { NodeOf } from '../workflows/spec';
import type { AgentService } from './service';
import { isTerminalRun } from './service';

/**
 * A routine's step.agent: the named agent runs the step's task in its own window, as a run of its own (with
 * its own budget and log), and the step waits for it without holding the routine in memory: it is put away
 * and woken until the agent's run ends. The engine asks the user before the step starts (it may act).
 */

// How often a waiting step checks on the agent's run
export const AGENT_STEP_POLL_MS = 15_000;

interface AgentStepState {
  agentRunId: string;
}

export function agentStepExecutor(
  service: Pick<AgentService, 'runForWorkflow'>,
  database: AviCopilotDb,
  now: () => number = Date.now,
): StepExecutor {
  return {
    // Not repeated by itself: the agent may have done something before it failed
    retry: null,
    // What an agent reads comes from outside
    taints: true,
    resumable: true,
    async execute(context) {
      const node = context.params as unknown as NodeOf<'step.agent'>;
      let state = context.state as AgentStepState | null;
      if (!state?.agentRunId) {
        if (!node.agent?.trim()) {
          throw new AppError('invalid', `"${node.label}" names no agent: set the agent's name on the step.`);
        }
        const run = await service.runForWorkflow({
          agent: node.agent,
          task: node.task,
          workflowName: context.workflow.name,
          workspaceId: context.workflow.workspaceId,
          tainted: context.run.tainted,
          firingKey: `workflow:${context.run.id}:${node.id}`,
        });
        state = { agentRunId: run.id };
        await context.saveState(state);
      }

      const agentRun = await database.runs.get(state.agentRunId);
      if (!agentRun) throw new AppError('not_found', "The agent's run was deleted.");
      if (agentRun.status === 'succeeded') {
        const steps = await database.runSteps.where('runId').equals(agentRun.id).toArray();
        const answer = String(steps.find(step => step.nodeId === 'task')?.output ?? '');
        return {
          kind: 'done',
          output: answer,
          tainted: true,
          // The agent's model calls count against its own budget; its cost shows on the routine's run too
          usage: { inputTokens: agentRun.inputTokens, outputTokens: agentRun.outputTokens, costUsd: agentRun.costUsd },
        };
      }
      if (isTerminalRun(agentRun.status)) {
        const message = agentRun.error?.message || `The agent's run ended ${agentRun.status}.`;
        if (agentRun.status === 'cancelled') throw new AppError('cancelled', message);
        const started = (
          (await database.runSteps.where('runId').equals(agentRun.id).toArray()).find(step => step.nodeId === 'task')
            ?.state as AgentTaskState | null | undefined
        )?.threadId;
        // Refused before it began (budget, paused): known not to have happened. Stopped part way: it may have
        throw new AppError(started ? 'unknown' : 'invalid', message, { retryable: false });
      }
      return {
        kind: 'park',
        until: now() + AGENT_STEP_POLL_MS,
        waitingUser: agentRun.status === 'waiting_user',
        state,
        tainted: true,
      };
    },
  };
}
