import { toAppError } from '@extension/shared';
import type { CompanionClient } from './client';
import { brainSettingsStore, brainStatusStore } from './state';
import type { BrainStatus } from './state';

/**
 * Asks Avi Brain how it is and keeps the answer for the shell and Settings. Never throws: a companion
 * that is not running is a status ("offline"), not an error; one that no longer knows this browser
 * (its token was revoked on the Mac) unpairs it here too.
 */
export async function refreshStatus(
  client: CompanionClient,
  options: { fresh?: boolean; manual?: boolean; now?: () => number } = {},
): Promise<BrainStatus> {
  const now = options.now ?? Date.now;
  const settings = await brainSettingsStore.getSettings();
  if (!settings.paired) return brainStatusStore.update({ state: 'unpaired', checkedAt: now(), message: null });
  try {
    const health = await client.health({ fresh: options.fresh, bypassBreaker: options.manual });
    if (settings.companionId && health.companionId !== settings.companionId) {
      return brainStatusStore.update({
        state: 'error',
        checkedAt: now(),
        message: 'A different Avi Brain answers on this port. Pair again.',
      });
    }
    const dockerProblem = health.docker.state !== 'up' || !health.docker.imageReady;
    return brainStatusStore.update({
      state: 'online',
      checkedAt: now(),
      message: dockerProblem ? health.docker.message : null,
      version: health.version,
      docker: health.docker,
      engine: health.engine,
      mcp: health.mcp,
    });
  } catch (error) {
    const appError = toAppError(error);
    if (appError.kind === 'auth' && appError.status === 401) {
      await brainSettingsStore.update({ paired: false });
      await client.unpair().catch(() => {});
      return brainStatusStore.update({
        state: 'unpaired',
        checkedAt: now(),
        message: 'Avi Brain no longer knows this browser. Pair again.',
        docker: null,
        engine: null,
        mcp: [],
      });
    }
    return brainStatusStore.update({
      state:
        appError.kind === 'network' || appError.kind === 'unavailable' || appError.kind === 'timeout'
          ? 'offline'
          : 'error',
      checkedAt: now(),
      message: appError.message,
    });
  }
}
