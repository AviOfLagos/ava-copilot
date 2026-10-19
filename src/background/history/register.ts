// "Bring in your AI history": the panel reads the folders the user picked and sends conversations here,
// where they are redacted, routed to workspaces and kept in the knowledge base. Workspace summaries are
// a job after each import and every morning.
import { z } from 'zod';
import { historyStore, kbStore } from '@extension/storage';
import type { HistoryImport } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { jobs, registerJobHandler } from '../jobs/runner';
import { createLogger } from '../log';
import { answerOneOff, registerAgentAction, registerCommand, registerRecovery } from '../registry';
import { services } from '../registry/services';
import { createWorkspaceContextAction, WORKSPACE_CONTEXT_PROMPT } from './action';
import { BATCH_SIZE, conversationSchema, importBatch } from './importer';
import { projectKey } from './route';
import { workspaceSummaries } from './summaries';
import { AI_TOOLS } from './tools';

const logger = createLogger('History');

export const SUMMARY_JOB = 'workspace_summaries';
const SOON_KEY = 'history:summaries:soon';
const DAILY_KEY = 'history:summaries:daily';
// Before the morning brief's usual 08:00, so it has fresh summaries
const DAILY_CRON = '30 7 * * *';

function command<S extends z.ZodType>(
  type: string,
  schema: S,
  run: (input: z.infer<S>) => Promise<Record<string, unknown> | void>,
): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      const result = (await run(input)) ?? {};
      context.reply({ type: 'history_ok', requestId: context.requestId, ...result });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
    }
  });
}

async function findImport(importId: string): Promise<HistoryImport> {
  const record = (await historyStore.imports()).find(item => item.id === importId);
  if (!record) throw new Error('That import is gone. Add the folder again.');
  return record;
}

const importId = z.string().regex(/^[a-z0-9-]{8,64}$/);

command('history_add_import', z.object({ label: z.string().min(1).max(200) }), async ({ label }) => {
  const record: HistoryImport = {
    id: crypto.randomUUID(),
    label: label.trim(),
    tools: [],
    createdAt: Date.now(),
    lastImportAt: null,
    lastCounts: null,
  };
  await historyStore.saveImport(record);
  return { importId: record.id };
});

command(
  'history_import_batch',
  z.object({ importId, conversations: z.array(conversationSchema).max(BATCH_SIZE), force: z.boolean().optional() }),
  async input => {
    await findImport(input.importId);
    return { ...(await importBatch(input.importId, input.conversations, services().kb, input.force ?? false)) };
  },
);

command(
  'history_import_done',
  z.object({
    importId,
    tools: z.array(z.enum(AI_TOOLS)).max(AI_TOOLS.length),
    counts: z.object({
      added: z.number().int().min(0),
      updated: z.number().int().min(0),
      unchanged: z.number().int().min(0),
      redacted: z.number().int().min(0),
      capped: z.boolean(),
    }),
  }),
  async input => {
    const record = await findImport(input.importId);
    await historyStore.saveImport({
      ...record,
      tools: [...new Set([...record.tools, ...input.tools])],
      lastImportAt: Date.now(),
      lastCounts: input.counts,
    });
    if (input.counts.added || input.counts.updated) {
      await jobs.schedule({ kind: SUMMARY_JOB, key: SOON_KEY, runAt: Date.now() + 2000 });
    }
  },
);

command('history_forget', z.object({ importId }), async input => {
  const items = (await kbStore.items()).filter(
    item => item.sourceType === 'ai-session' && item.origin?.importId === input.importId,
  );
  for (const item of items) await services().kb.remove(item.id);
  await historyStore.removeImport(input.importId);
  await jobs.schedule({ kind: SUMMARY_JOB, key: SOON_KEY, runAt: Date.now() + 2000 });
  return { removed: items.length };
});

command(
  'history_map_project',
  z.object({ project: z.string().min(1).max(1000), workspaceId: z.string().max(100).nullable() }),
  async input => {
    const project = projectKey(input.project)!;
    await historyStore.mapProject(project, input.workspaceId);
    // Every session from that folder, or a folder inside it, moves with it
    const ids = (await kbStore.items())
      .filter(item => {
        const own = item.origin?.project;
        return item.sourceType === 'ai-session' && !!own && (own === project || own.startsWith(`${project}/`));
      })
      .map(item => item.id);
    const moved = await services().kb.setWorkspace(ids, input.workspaceId);
    if (moved) await jobs.schedule({ kind: SUMMARY_JOB, key: SOON_KEY, runAt: Date.now() + 2000 });
    return { moved };
  },
);

command(
  'history_summarize',
  z.object({ workspaceId: z.string().max(100).nullable().optional(), force: z.boolean().optional() }),
  async input => {
    const built = await workspaceSummaries.refresh({ workspaceId: input.workspaceId, force: input.force ?? false });
    return { built: built.length };
  },
);

registerJobHandler(SUMMARY_JOB, async () => {
  await workspaceSummaries.refresh();
});

// Every morning, before the brief; scheduling the same key again replaces the job
registerRecovery('history', async () => {
  await jobs.schedule({ kind: SUMMARY_JOB, key: DAILY_KEY, cron: DAILY_CRON, catchUpMs: 6 * 60 * 60 * 1000 });
});

registerAgentAction({ prompt: WORKSPACE_CONTEXT_PROMPT, create: createWorkspaceContextAction });

// Extension pages (the panel's settings, Knowledge base) also send these as one-off messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if (typeof message?.type !== 'string' || !message.type.startsWith('history_')) return;
  // Answers on every path, a handler that throws too
  return answerOneOff(message, sendResponse);
});
