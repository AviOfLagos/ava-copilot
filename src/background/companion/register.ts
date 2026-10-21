// The companion stream (Nex Brain) registers its commands, jobs, recovery and the step.sandbox executor
// here (see ../registry and ../jobs/runner).
import { z } from 'zod';
import { toAppError } from '@extension/shared';
import { normalizePairingCode } from '@src/shared/lib/protocol/companion';
import { jobs, registerJobHandler } from '../jobs/runner';
import { createLogger } from '../log';
import { registerCommand, registerRecovery } from '../registry';
import { registerStepExecutor } from '../workflows/executors';
import { companionClient } from './client';
import { sandboxStepExecutor } from './executor';
import { brainSettingsStore, brainStatusStore, isValidPort } from './state';
import { refreshStatus } from './status';

const logger = createLogger('Brain');

export const HEALTH_JOB = 'brain_health';
const HEALTH_KEY = 'brain:health';
// Every two minutes while paired; a check by hand is immediate
const HEALTH_CRON = '*/2 * * * *';

async function scheduleHealth(): Promise<void> {
  await jobs.schedule({ kind: HEALTH_JOB, key: HEALTH_KEY, cron: HEALTH_CRON, catchUpMs: 60_000 });
}

/** A panel command: its result is the reply; a failure becomes a plain sentence. */
function command<S extends z.ZodType>(
  type: string,
  schema: S,
  run: (input: z.infer<S>) => Promise<Record<string, unknown> | void>,
): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      const result = (await run(input)) ?? {};
      context.reply({ type: 'brain_ok', requestId: context.requestId, ...result });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
    }
  });
}

const snapshot = async () => ({
  settings: await brainSettingsStore.getSettings(),
  status: await brainStatusStore.getStatus(),
});

command('brain_status', z.object({}), snapshot);

command('brain_set_port', z.object({ port: z.number().int() }), async ({ port }) => {
  if (!isValidPort(port)) throw new Error('A port is a number from 1024 to 65535.');
  await brainSettingsStore.update({ port });
  return snapshot();
});

command(
  'brain_pair',
  z.object({ code: z.string().max(40), port: z.number().int().optional() }),
  async ({ code, port }) => {
    const normalized = normalizePairingCode(code);
    if (!normalized) throw new Error('A pairing code has 8 letters and digits, like ABCD-2345.');
    if (port !== undefined) {
      if (!isValidPort(port)) throw new Error('A port is a number from 1024 to 65535.');
      await brainSettingsStore.update({ port });
    }
    const reply = await companionClient.pair(normalized);
    await brainSettingsStore.update({
      paired: true,
      companionId: reply.companionId,
      pairedAt: Date.now(),
      unpairedByUser: false,
    });
    await scheduleHealth();
    await refreshStatus(companionClient, { fresh: true, manual: true });
    logger.info('Paired with Nex Brain');
    return snapshot();
  },
);

/** Pairs with Nex Brain on this Mac without a code, when it is running and allows it. */
async function autoPair(): Promise<boolean> {
  if ((await brainSettingsStore.getSettings()).paired) return true;
  const reply = await companionClient.autoPair();
  await brainSettingsStore.update({
    paired: true,
    companionId: reply.companionId,
    pairedAt: Date.now(),
    unpairedByUser: false,
  });
  await scheduleHealth();
  await refreshStatus(companionClient, { fresh: true, manual: true });
  logger.info('Paired with Nex Brain automatically');
  return true;
}

command('brain_auto_pair', z.object({}), async () => {
  await autoPair();
  return snapshot();
});

command('brain_unpair', z.object({}), async () => {
  await companionClient.unpair();
  await brainSettingsStore.update({ paired: false, companionId: null, pairedAt: null, unpairedByUser: true });
  await jobs.cancel(HEALTH_KEY);
  await brainStatusStore.update({
    state: 'unpaired',
    message: null,
    docker: null,
    engine: null,
    mcp: [],
    version: null,
  });
  return snapshot();
});

command('brain_check', z.object({}), async () => {
  await refreshStatus(companionClient, { fresh: true, manual: true });
  return snapshot();
});

command('brain_artifacts', z.object({}), async () => {
  const { artifacts } = await companionClient.listArtifacts();
  return { artifacts: artifacts.slice(0, 20) };
});

command(
  'brain_open_artifact',
  z.object({ artifactId: z.string().regex(/^[a-f0-9]{16,32}$/) }),
  async ({ artifactId }) => {
    const url = await companionClient.openArtifact(artifactId);
    // Opened next to the user's tabs, as a normal page of the companion: no extension privileges
    await chrome.tabs.create({ url, active: true });
  },
);

registerJobHandler(HEALTH_JOB, async () => {
  await refreshStatus(companionClient);
});

// After a restart: keep checking while paired (scheduling the same key again replaces the job)
// Never pairs on its own here: whatever listens on the port could be pretending to be Nex Brain, so pairing waits for
// the user's click (the Nex Brain card, or Restore on a fresh install)
registerRecovery('companion', async () => {
  if ((await brainSettingsStore.getSettings()).paired) await scheduleHealth();
});

// Routines' step.sandbox runs in Nex Brain's sandbox
registerStepExecutor('step.sandbox', sandboxStepExecutor(companionClient));
