// The setup checklist: checks every part on a schedule and when a related setting changes, keeps the result for the
// pages (./state.ts) and the toolbar badge, and the few commands the checklist sends.
import { z } from 'zod';
import { toAppError } from '@extension/shared';
import { modelSettingsStore } from '@extension/storage';
import { MAC_APPS } from '@src/shared/lib/protocol/companion';
import { companionClient } from '../companion/client';
import { refreshBadge } from '../inbox/badge';
import { jobs, registerJobHandler } from '../jobs/runner';
import { createLogger } from '../log';
import { registerCommand, registerRecovery } from '../registry';
import { evaluateSetup } from './checks';
import { takeReadings } from './readers';
import { isRecommended, SETUP_STATE_KEY, setupStore } from './state';
import type { SetupState } from './state';

const logger = createLogger('Setup');

export const SETUP_JOB = 'setup_check';
const SETUP_KEY = 'setup:check';
// Often enough that the dot follows what changed outside the extension (Ollama started, Ava Brain stopped)
const SETUP_CRON = '*/15 * * * *';
// Storage changes come in bursts (a save writes several keys): one check after they settle
const SETTLE_MS = 1500;

// What the checks read: a change to any of these checks again (without asking Ava Brain)
const WATCHED_KEYS = new Set([
  'llm-api-keys',
  'agent-models',
  'model-settings',
  'kb-settings',
  'brain-settings',
  'brain-status',
  'meet-voice-state',
  'whatsapp-remote-state',
  'calendar-settings',
  'calendar-upcoming',
  'obsidian-vault',
  'vault-state',
  'backup-status',
]);

/** Once a local chat model is there, light work and failed cloud calls use it (unless the user chose one). */
async function adoptLocalModel(state: SetupState): Promise<void> {
  const local = state.items.find(entry => entry.id === 'local');
  const providerId = state.local?.providerId;
  if (!local || !providerId || !local.detail) return;
  if (local.problem !== null && local.problem !== 'local_no_embed') return;
  const settings = await modelSettingsStore.getSettings();
  const target = { providerId, model: local.detail };
  if (!settings.roles.local) await modelSettingsStore.setRole('local', target);
  if (!settings.fallbackLocal.model) {
    await modelSettingsStore.updateSettings({ fallbackLocal: { ...settings.fallbackLocal, model: target } });
  }
}

let running: Promise<SetupState> | null = null;
let again: boolean | null = null;

/** Checks everything now; one check at a time, and a check asked for meanwhile runs once after it. */
export function checkSetup(fresh = false): Promise<SetupState> {
  if (running) {
    again = Boolean(again) || fresh;
    return running;
  }
  const run = (async () => {
    const { readings, brainInfo } = await takeReadings(fresh);
    const items = evaluateSetup(readings);
    const state = await setupStore.update({
      items,
      brain: brainInfo,
      local: { providerId: readings.local.providerId, kind: readings.local.kind, root: readings.local.root },
      checkedAt: Date.now(),
    });
    await adoptLocalModel(state).catch(error => logger.warning(`Local model not set (${toAppError(error).kind})`));
    await refreshBadge().catch(() => {});
    return state;
  })();
  running = run;
  void run
    .catch(error => logger.warning(`Setup check failed (${toAppError(error).kind})`))
    .finally(() => {
      running = null;
      if (again !== null) {
        const fresh = again;
        again = null;
        void checkSetup(fresh);
      }
    });
  return run;
}

let settle: ReturnType<typeof setTimeout> | null = null;

function checkSoon(): void {
  if (settle) clearTimeout(settle);
  settle = setTimeout(() => {
    settle = null;
    void checkSetup(false).catch(() => {});
  }, SETTLE_MS);
}

globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
  if (area !== 'local' || SETUP_STATE_KEY in changes) return;
  if (Object.keys(changes).some(key => WATCHED_KEYS.has(key))) checkSoon();
});

// ── Commands ──────────────────────────────────────────────────────────────────────────────────────

function command<S extends z.ZodType>(
  type: string,
  schema: S,
  run: (input: z.infer<S>) => Promise<Record<string, unknown> | void>,
): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      const result = (await run(input)) ?? {};
      context.reply({ type: 'setup_ok', requestId: context.requestId, ...result });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
    }
  });
}

const itemId = z.string().min(1).max(20);

// "Check again" and opening the checklist: asks Ava Brain too
command('setup_status', z.object({ fresh: z.boolean().optional() }), async ({ fresh }) => ({
  state: await checkSetup(fresh !== false),
}));

command('setup_skip', z.object({ id: itemId }), async ({ id }) => {
  if (!isRecommended(id)) throw new Error('Only a recommended step can be skipped.');
  const current = await setupStore.getState();
  const state = await setupStore.update({ skipped: [...current.skipped, id] });
  await refreshBadge().catch(() => {});
  return { state };
});

command('setup_unskip', z.object({ id: itemId }), async ({ id }) => {
  const current = await setupStore.getState();
  const state = await setupStore.update({ skipped: current.skipped.filter(skipped => skipped !== id) });
  await refreshBadge().catch(() => {});
  return { state };
});

// "Open Ollama": Ava Brain opens the app on the Mac (only Ollama or LM Studio, by name from a fixed list)
command('setup_open_app', z.object({ app: z.enum(MAC_APPS) }), async ({ app }) => {
  await companionClient.openApp(app);
  // The server takes a few seconds to answer once the app is open; the checklist checks again itself
  return { opened: app };
});

// ── Schedule ──────────────────────────────────────────────────────────────────────────────────────

registerJobHandler(SETUP_JOB, async () => {
  await checkSetup(true);
});

registerRecovery('setup', async () => {
  await jobs.schedule({ kind: SETUP_JOB, key: SETUP_KEY, cron: SETUP_CRON, catchUpMs: 15 * 60_000 });
  void checkSetup(false).catch(() => {});
});
