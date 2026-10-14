// WhatsApp Web (Ava in the user's own tab): agent actions for catch-up and drafts, and bulk messages as jobs.
import { z } from 'zod';
import { BULK_HARD_DAILY_CAP, BULK_MAX_MESSAGE_CHARS, whatsappBulkSettingsStore } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { registerJobHandler } from '../jobs/runner';
import { createLogger } from '../log';
import { registerCommand, registerRecovery } from '../registry';
import { registerWhatsappActions } from './actions';
import {
  BULK_JOB_KIND,
  answerBatch,
  createBatch,
  deleteBatch,
  pauseBatch,
  recoverBatches,
  resumeBatch,
  runBulkJob,
  stopBatch,
} from './bulk/service';

const logger = createLogger('WhatsApp');

function command<S extends z.ZodType>(
  type: string,
  schema: S,
  run: (input: z.infer<S>) => Promise<Record<string, unknown> | void>,
): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      const result = (await run(input)) ?? {};
      context.reply({ type: 'wa_ok', requestId: context.requestId, ...result });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
    }
  });
}

const runId = z.string().uuid();

command(
  'wa_bulk_create',
  z.object({
    csv: z.string().min(1).max(2_000_000),
    template: z.string().min(1).max(BULK_MAX_MESSAGE_CHARS),
    attachment: z
      .object({
        name: z.string().min(1).max(300),
        type: z.string().max(200),
        // 5 MB as base64, with room for padding
        base64: z.string().min(1).max(7_100_000),
      })
      .nullable()
      .optional(),
  }),
  async input => {
    const run = await createBatch(input);
    return { runId: run.id };
  },
);
// Named approvalId, not requestId: PanelApi.request adds its own requestId for matching the reply
command('wa_bulk_answer', z.object({ runId, approvalId: z.string().uuid(), approved: z.boolean() }), async input => {
  await answerBatch(input.runId, input.approvalId, input.approved);
});
command('wa_bulk_pause', z.object({ runId }), async input => pauseBatch(input.runId));
command('wa_bulk_resume', z.object({ runId }), async input => resumeBatch(input.runId));
command('wa_bulk_stop', z.object({ runId }), async input => stopBatch(input.runId));
command('wa_bulk_delete', z.object({ runId }), async input => deleteBatch(input.runId));
command(
  'wa_bulk_settings',
  z.object({
    changes: z
      .object({
        delayMinSec: z.number().min(0).max(3600),
        delayMaxSec: z.number().min(0).max(3600),
        cooldownEvery: z.number().min(1).max(1000),
        cooldownMinSec: z.number().min(0).max(86_400),
        cooldownMaxSec: z.number().min(0).max(86_400),
        dailyCap: z.number().min(1).max(BULK_HARD_DAILY_CAP),
      })
      .partial(),
  }),
  async input => {
    const settings = await whatsappBulkSettingsStore.updateSettings(input.changes);
    return { settings };
  },
);

registerJobHandler(BULK_JOB_KIND, (job, signal) => runBulkJob(job.payload, signal));
registerRecovery('whatsapp-bulk', recoverBatches);
registerWhatsappActions();
