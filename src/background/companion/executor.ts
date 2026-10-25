import { AppError, toAppError } from '@extension/shared';
import { sandboxProfileFor } from '@src/shared/lib/protocol/companion';
import type { StepExecutor } from '../workflows/engine';
import type { NodeOf } from '../workflows/spec';
import type { CompanionClient } from './client';
import { NOT_RUNNING_MESSAGE } from './client';

/**
 * `step.sandbox` for routines run by the extension: the command runs in Ava Brain's Docker sandbox on
 * the Mac (the agent's, or the one shared by routines). The engine already waited for the user's click
 * (it is a side effect), and never repeats it.
 *
 * Before sending, Ava Brain is asked whether it is there: if not, the command certainly did not run and
 * the step fails plainly. Once sent, a dropped connection means it may have run (unknown outcome). The
 * request id is the run and step, so a repeat reaching the Mac gets the first answer instead of running
 * the command again.
 */
export function sandboxStepExecutor(client: CompanionClient): StepExecutor {
  return {
    retry: null,
    // What a command prints may come from outside (its network, the files it read)
    taints: true,
    async execute({ params, run, workflow, signal }) {
      const node = params as unknown as NodeOf<'step.sandbox'>;
      try {
        const health = await client.health({ signal });
        if (health.docker.state !== 'up' || !health.docker.imageReady) {
          throw new AppError('unavailable', health.docker.message, { retryable: false });
        }
      } catch (error) {
        const appError = toAppError(error);
        if (appError.kind === 'network' || appError.kind === 'timeout') {
          throw new AppError('unavailable', NOT_RUNNING_MESSAGE, { retryable: false });
        }
        throw appError;
      }
      const result = await client.runSandbox(
        { requestId: `${run.id}:${node.id}`, profileId: sandboxProfileFor(workflow.agentId), command: node.command },
        signal,
      );
      if (result.exitCode !== 0) {
        const tail = (result.stderr || result.stdout).trim().split('\n').slice(-5).join('\n');
        throw new AppError('invalid', `The command failed (exit ${result.exitCode})${tail ? `: ${tail}` : '.'}`, {
          retryable: false,
        });
      }
      return {
        kind: 'done',
        output: {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
        },
        tainted: true,
      };
    },
  };
}
