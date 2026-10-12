import { describe, expect, it, vi } from 'vitest';

await vi.hoisted(async () => {
  const { installChromeStub } = await import('./chrome-stub');
  installChromeStub();
});

import { AppError } from '@extension/shared';
import type { RunRecord, WorkflowRecord } from '@extension/storage';
import type { StepContext } from '../../workflows/engine';
import type { CompanionClient } from '../client';
import { NOT_RUNNING_MESSAGE } from '../client';
import { sandboxStepExecutor } from '../executor';

const up = { docker: { state: 'up', message: 'Docker is running.', version: '29', imageReady: true } };

function context(agentId: string | null = null): StepContext {
  const node = { id: 'build', type: 'step.sandbox', label: 'Build', command: 'pnpm build' } as const;
  return {
    node,
    params: { ...node },
    run: { id: 'run-1' } as RunRecord,
    workflow: { id: 'wf-1', agentId } as WorkflowRecord,
    state: null,
    saveState: async () => {},
    signal: new AbortController().signal,
  };
}

function fakeClient(options: { health?: () => Promise<unknown>; run?: (request: unknown) => Promise<unknown> }) {
  const requests: unknown[] = [];
  const client = {
    health: options.health ?? (async () => up),
    runSandbox: async (request: unknown) => {
      requests.push(request);
      return (
        options.run ??
        (async () => ({
          ok: true,
          exitCode: 0,
          stdout: 'built\n',
          stderr: '',
          timedOut: false,
          truncated: false,
          durationMs: 5,
        }))
      )(request);
    },
  } as unknown as CompanionClient;
  return { client, requests };
}

describe('step.sandbox executor', () => {
  it('runs the command in the routine sandbox and returns what it printed', async () => {
    const { client, requests } = fakeClient({});
    const executor = sandboxStepExecutor(client);
    expect(executor).toMatchObject({ retry: null, taints: true });
    const outcome = await executor.execute(context());
    expect(outcome).toEqual({
      kind: 'done',
      output: { exitCode: 0, stdout: 'built\n', stderr: '', truncated: false },
      tainted: true,
    });
    // The run and step name the request, so a repeat gets the first answer instead of a second run
    expect(requests).toEqual([{ requestId: 'run-1:build', profileId: 'routines', command: 'pnpm build' }]);
  });

  it("uses the routine's agent sandbox when it has one", async () => {
    const { client, requests } = fakeClient({});
    await sandboxStepExecutor(client).execute(context('agent-7'));
    expect(requests[0]).toMatchObject({ profileId: 'agent-7' });
  });

  it('fails plainly when Avi Brain is not running, before sending anything', async () => {
    const { client, requests } = fakeClient({
      health: async () => {
        throw new AppError('network', NOT_RUNNING_MESSAGE);
      },
    });
    await expect(sandboxStepExecutor(client).execute(context())).rejects.toMatchObject({
      kind: 'unavailable',
      message: NOT_RUNNING_MESSAGE,
    });
    expect(requests).toHaveLength(0);
  });

  it('passes on the Docker Desktop message when Docker is down', async () => {
    const { client, requests } = fakeClient({
      health: async () => ({
        docker: {
          state: 'down',
          message: 'Docker is not running. Start Docker Desktop, then try again.',
          version: null,
          imageReady: false,
        },
      }),
    });
    await expect(sandboxStepExecutor(client).execute(context())).rejects.toThrow(/Start Docker Desktop/);
    expect(requests).toHaveLength(0);
  });

  it('fails the step when the command fails, with the end of its output', async () => {
    const { client } = fakeClient({
      run: async () => ({
        ok: true,
        exitCode: 2,
        stdout: '',
        stderr: 'line 1\nerror: missing script build',
        timedOut: false,
        truncated: false,
        durationMs: 5,
      }),
    });
    await expect(sandboxStepExecutor(client).execute(context())).rejects.toMatchObject({
      kind: 'invalid',
      message: 'The command failed (exit 2): line 1\nerror: missing script build',
    });
  });

  it('lets a connection lost mid-run stay a network error, which the engine records as an unknown outcome', async () => {
    const { client } = fakeClient({
      run: async () => {
        throw new AppError('network', NOT_RUNNING_MESSAGE);
      },
    });
    await expect(sandboxStepExecutor(client).execute(context())).rejects.toMatchObject({ kind: 'network' });
  });
});
