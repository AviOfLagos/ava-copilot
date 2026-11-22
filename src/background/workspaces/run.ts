import { toAppError } from '@extension/shared';
import { createLogger } from '../log';
import { sortDeps } from './deps';
import { lightSuggestModel } from './model';
import { sortUnplaced } from './sort';

const logger = createLogger('Workspaces');

export const SORT_JOB = 'workspaces_sort';

/**
 * One sorting pass now (docs/pm-desk.md, Part 3). `guess: false` skips the model, which the brief does so it is not slowed:
 * the periodic job does the guessing. Never throws: sorting is a help, and a failure must not stop a brief or a start-up.
 */
export async function sortNow(options: { guess?: boolean } = {}) {
  try {
    const result = await sortUnplaced(sortDeps(options.guess === false ? null : lightSuggestModel()), options);
    if (result.moved.length || result.offered) {
      logger.info(`Workspaces: ${result.moved.length} rule moves, ${result.offered} offers`);
    }
    return result;
  } catch (error) {
    logger.warning('The sorting pass failed', toAppError(error).kind);
    return { moved: [], offered: 0 };
  }
}
