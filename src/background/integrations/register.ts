// The integrations stream registers its commands, jobs, agent actions, voice tools and recovery here
// (see ../registry and ../jobs/runner).
import { db } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { jobs, registerJobHandler } from '../jobs/runner';
import { createLogger } from '../log';
import { registerAgentAction, registerRecovery } from '../registry';
import { registerStepExecutor } from '../workflows/executors';
import { callToolAgentAction } from './action';
import { registerConnectorCommands } from './commands';
import { connectorService, connectorStore, oauthManager } from './instance';
import { toolStepExecutor } from './step';

const logger = createLogger('Connectors');

// Every connector's tools are read again now and then, so a tool that changed on its server is caught (and
// turned off) even when nothing calls it
export const TOOLS_REFRESH_JOB = 'connectors_refresh';
const TOOLS_REFRESH_KEY = 'connectors:refresh';
const TOOLS_REFRESH_CRON = '37 */6 * * *';

registerConnectorCommands(connectorService);
registerAgentAction(callToolAgentAction(connectorService));
registerStepExecutor('step.tool', toolStepExecutor(connectorService));

registerJobHandler(TOOLS_REFRESH_JOB, async (_job, signal) => {
  for (const connector of await connectorStore.list()) {
    if (signal.aborted) return;
    if (connector.kind !== 'mcp_http' || (connector.status !== 'connected' && connector.status !== 'error')) continue;
    // One connector failing is recorded on it; the others are still read
    await connectorService
      .refresh(connector.id, signal)
      .catch(error => logger.warning(`Could not read ${connector.id}'s tools (${toAppError(error).kind})`));
  }
});

registerRecovery('integrations', async () => {
  // Sign-ins never finished are forgotten
  await oauthManager.prunePending().catch(() => {});
  // Scheduled once: rewriting it at every start would move its next run
  const existing = await db.jobs.where('key').equals(TOOLS_REFRESH_KEY).first();
  if (existing?.cron === TOOLS_REFRESH_CRON && existing.status !== 'failed' && existing.status !== 'done') return;
  await jobs.schedule({
    kind: TOOLS_REFRESH_JOB,
    key: TOOLS_REFRESH_KEY,
    cron: TOOLS_REFRESH_CRON,
    catchUpMs: 6 * 60 * 60_000,
  });
});
