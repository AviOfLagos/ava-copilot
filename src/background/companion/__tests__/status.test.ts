import { beforeEach, describe, expect, it, vi } from 'vitest';

const stub = await vi.hoisted(async () => {
  const { installChromeStub } = await import('./chrome-stub');
  return installChromeStub();
});

import { AppError } from '@extension/shared';
import type { CompanionClient } from '../client';
import { brainSettingsStore, brainStatusStore, DEFAULT_BRAIN_SETTINGS } from '../state';
import { refreshStatus } from '../status';

const health = (docker: Record<string, unknown> = {}) => ({
  ok: true,
  protocol: 1,
  version: '0.1.0',
  companionId: 'mac-1',
  uptimeMs: 1,
  docker: { state: 'up', message: 'Docker is running.', version: '29', imageReady: true, ...docker },
  engine: { kind: 'eve', state: 'ready', message: null },
  mcp: [{ name: 'notes', state: 'ready', tools: 2, error: null }],
  workflows: { active: 1, running: 0 },
});

function fakeClient(answer: () => Promise<unknown>) {
  const unpair = vi.fn(async () => {});
  return { client: { health: answer, unpair } as unknown as CompanionClient, unpair };
}

describe('refreshStatus', () => {
  beforeEach(async () => {
    stub.local.clear();
    await brainSettingsStore.set({ ...DEFAULT_BRAIN_SETTINGS, paired: true, companionId: 'mac-1' });
  });

  it('is unpaired until paired, without asking the Mac', async () => {
    await brainSettingsStore.update({ paired: false });
    const { client } = fakeClient(async () => {
      throw new Error('should not be called');
    });
    expect((await refreshStatus(client)).state).toBe('unpaired');
  });

  it('is online with what the Mac reports, and says when Docker needs starting', async () => {
    const online = await refreshStatus(fakeClient(async () => health()).client);
    expect(online).toMatchObject({ state: 'online', message: null, version: '0.1.0', mcp: [{ name: 'notes' }] });
    const down = await refreshStatus(
      fakeClient(async () =>
        health({
          state: 'down',
          imageReady: false,
          message: 'Docker is not running. Start Docker Desktop, then try again.',
        }),
      ).client,
    );
    expect(down).toMatchObject({
      state: 'online',
      message: 'Docker is not running. Start Docker Desktop, then try again.',
    });
    expect((await brainStatusStore.getStatus()).docker?.state).toBe('down');
  });

  it('is offline when Ava Brain does not answer', async () => {
    const status = await refreshStatus(
      fakeClient(async () => {
        throw new AppError('network', 'Ava Brain is not running on your Mac. Start it, then try again.');
      }).client,
    );
    expect(status).toMatchObject({
      state: 'offline',
      message: 'Ava Brain is not running on your Mac. Start it, then try again.',
    });
  });

  it('unpairs when the Mac no longer knows this browser', async () => {
    const { client, unpair } = fakeClient(async () => {
      throw new AppError('auth', 'Pair again.', { status: 401 });
    });
    const status = await refreshStatus(client);
    expect(status.state).toBe('unpaired');
    expect((await brainSettingsStore.getSettings()).paired).toBe(false);
    expect(unpair).toHaveBeenCalled();
  });

  it('notices a different companion on the same port', async () => {
    const status = await refreshStatus(fakeClient(async () => ({ ...health(), companionId: 'someone-else' })).client);
    expect(status).toMatchObject({ state: 'error' });
  });
});
