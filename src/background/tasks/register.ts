// The task board (docs/pm-desk.md, Part 2): the one-time backfill of the last 30 days. Meeting notes and graph
// readings reach the board through ./sources.ts, called where each source is saved.
import { createLogger } from '../log';
import { registerRecovery } from '../registry';
import { backfillOnce } from './backfill';

const logger = createLogger('Tasks');

registerRecovery('tasks', async () => {
  await backfillOnce().catch(error => logger.warning('Could not fill the task board from the last 30 days', error));
});
