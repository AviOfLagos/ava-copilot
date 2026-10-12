import { db as defaultDb, retentionCutoffDay, USAGE_RETENTION_DAYS } from '@extension/storage';
import type { AviCopilotDb } from '@extension/storage';

/**
 * Deletes usage events older than the retention window (90 days). The daily totals in `usageStore` keep
 * their own, shorter window.
 *
 * @returns How many events were deleted
 */
export async function pruneUsageEvents(
  database: AviCopilotDb = defaultDb,
  now = new Date(),
  days = USAGE_RETENTION_DAYS,
): Promise<number> {
  return database.usageEvents.where('day').below(retentionCutoffDay(now, days)).delete();
}
