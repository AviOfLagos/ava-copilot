import { meetingSettingsStore } from '@extension/storage';
// The models stream registers its commands, jobs, agent actions, voice tools and recovery here
// (see ../registry and ../jobs/runner).
import {
  db,
  getProviderTypeByProviderId,
  hasPlaintextKeys,
  isLocalProvider,
  llmProviderStore,
  LLM_PROVIDERS_STORAGE_KEY,
  migrateProviderKeys,
  modelHealthStore,
  modelSettingsStore,
} from '@extension/storage';
import type { ProviderConfig } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { registerCommand, registerRecovery } from '../registry';
import { jobs, registerJobHandler } from '../jobs/runner';
import { createLogger } from '../log';
import { pruneUsageEvents } from '../usage/retention';
import { refreshCatalog } from './catalog';
import { keepLocalServerRules } from './localServers';
import {
  answer,
  checkSavedOrDraft,
  checkSchema,
  lightRouteSchema,
  localProbe,
  localProbeSchema,
  localReport,
  localReportSchema,
  testModel,
  testModelSchema,
  refreshSchema,
  removeProvider,
  removeSchema,
  saveProvider,
  saveSchema,
} from './commands';
import { forgetLocalChecks, lightRoute } from './light';
import { liveTokenFromSettings } from './liveToken';

const logger = createLogger('Models');

export const REFRESH_JOB = 'models_refresh';
export const RETENTION_JOB = 'usage_retention';
const REFRESH_NOW_KEY = 'models:refresh-now';
const REFRESH_NEXT_KEY = 'models:refresh-next';
const REFRESH_CRON_KEY = 'models:refresh-cron';
const RETENTION_KEY = 'usage:retention';
// Every 6 hours, at a quiet minute
const REFRESH_CRON = '7 */6 * * *';
const RETENTION_CRON = '23 4 * * *';
// A background that starts again soon after a refresh does not refresh again
const START_REFRESH_AFTER_MS = 60 * 60_000;

// ── Jobs ──────────────────────────────────────────────────────────────────────────────────────────

registerJobHandler(REFRESH_JOB, async (job, signal) => {
  const payload = (job.payload ?? {}) as { probeLocal?: boolean; providerIds?: string[] };
  // A provider that fails is recorded in its health; the job itself only fails when it cannot run at all
  await refreshCatalog({ signal, probeLocal: payload.probeLocal === true, providerIds: payload.providerIds });
});

registerJobHandler(RETENTION_JOB, async () => {
  const deleted = await pruneUsageEvents();
  if (deleted) logger.info(`Usage events older than 90 days deleted: ${deleted}`);
});

interface RefreshPayload {
  probeLocal?: boolean;
  providerIds?: string[];
}

/** Refreshes soon, as a job (it can take longer than a request may wait), and starts it now if it can. */
async function refreshSoon(payload: RefreshPayload = {}, delayMs = 0) {
  // A refresh already running finishes its own row; a new request waits in a second one
  const current = await db.jobs.where('key').equals(REFRESH_NOW_KEY).first();
  const key = current?.status === 'running' ? REFRESH_NEXT_KEY : REFRESH_NOW_KEY;
  const pending = key === REFRESH_NOW_KEY ? current : await db.jobs.where('key').equals(key).first();
  const waiting = pending?.status === 'scheduled' ? (pending.payload as RefreshPayload | null) : null;
  // Two requests in a row make one refresh that covers both
  const merged: RefreshPayload = waiting
    ? {
        probeLocal: Boolean(waiting.probeLocal || payload.probeLocal),
        providerIds:
          waiting.providerIds && payload.providerIds
            ? [...new Set([...waiting.providerIds, ...payload.providerIds])]
            : undefined,
      }
    : payload;
  const runAt = Math.min(Date.now() + delayMs, waiting && pending ? pending.runAt : Infinity);
  await jobs.schedule({ kind: REFRESH_JOB, key, runAt, payload: merged });
  // The jobs alarm would run it within 30 s anyway; this only saves the wait while the background is up
  if (delayMs === 0) void jobs.tick();
  else setTimeout(() => void jobs.tick(), delayMs + 50);
}

/** Schedules a repeating job once; rewriting it at every start would move its next run. */
async function ensureRepeating(kind: string, key: string, cron: string) {
  const existing = await db.jobs.where('key').equals(key).first();
  if (existing?.cron === cron && existing.status !== 'failed' && existing.status !== 'done') return;
  await jobs.schedule({ kind, key, cron, catchUpMs: 6 * 60 * 60_000 });
}

// ── Keys: out of plain storage, into the vault ────────────────────────────────────────────────────

let moving: Promise<void> | null = null;

/** Moves plaintext keys into the vault; one pass at a time. */
function moveKeysToVault(): Promise<void> {
  moving ??= (async () => {
    try {
      if (!(await hasPlaintextKeys())) return;
      const { migrated, failed } = await migrateProviderKeys();
      if (migrated.length) logger.info(`Moved ${migrated.length} provider key(s) into the vault`);
      if (failed.length) {
        logger.warning(`Could not move ${failed.length} provider key(s) yet; they stay where they were`);
      }
    } finally {
      moving = null;
    }
  })();
  return moving;
}

// Settings are written as one record, so the move waits for a burst of writes to settle before rewriting it
const SETTLE_MS = 1000;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

// What decides a provider's model list: changes to these refresh the catalog
function providerSignature(providers: Record<string, ProviderConfig> | undefined): string {
  return JSON.stringify(
    Object.entries(providers ?? {})
      .map(([id, config]) => [
        id,
        config?.type ?? getProviderTypeByProviderId(id),
        config?.baseUrl ?? '',
        Boolean(config?.hasKey || config?.apiKey),
        config?.keyLast4 ?? '',
        (config?.azureDeploymentNames ?? []).join(','),
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

// Another page or an older build wrote a key in plaintext, or providers changed: move it, then refresh
chrome.storage?.onChanged?.addListener((changes, area) => {
  const change = changes[LLM_PROVIDERS_STORAGE_KEY];
  if (area !== 'local' || !change) return;
  const before = providerSignature((change.oldValue as { providers?: Record<string, ProviderConfig> })?.providers);
  const after = providerSignature((change.newValue as { providers?: Record<string, ProviderConfig> })?.providers);
  // A short delay gathers a burst of saves into one refresh
  if (before !== after) void refreshSoon({}, 2000).catch(() => {});
  // A worker stopped before the timer fires moves the keys at its next start
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    moveKeysToVault().catch(error => logger.warning(`Keys not moved yet (${toAppError(error).kind})`));
  }, SETTLE_MS);
});

// ── Start ─────────────────────────────────────────────────────────────────────────────────────────

registerRecovery('models', async () => {
  await moveKeysToVault();
  await ensureRepeating(REFRESH_JOB, REFRESH_CRON_KEY, REFRESH_CRON);
  await ensureRepeating(RETENTION_JOB, RETENTION_KEY, RETENTION_CRON);
  const [{ lastRefreshAt }, { localProbeDone }] = await Promise.all([
    modelHealthStore.getHealth(),
    modelSettingsStore.getSettings(),
  ]);
  if (!lastRefreshAt || Date.now() - lastRefreshAt > START_REFRESH_AFTER_MS || !localProbeDone) {
    // First run also looks for Ollama and LM Studio on this machine
    await refreshSoon({ probeLocal: !localProbeDone }, 5000);
  }
});

// Opening the panel checks again a local server that was down or refused, so a stale status does not stay
const RECHECK_LOCAL_AFTER_MS = 60_000;

async function recheckFailedLocal(): Promise<void> {
  const [{ providers: health }, providers] = await Promise.all([
    modelHealthStore.getHealth(),
    llmProviderStore.getAllProviders(),
  ]);
  const now = Date.now();
  const providerIds = Object.entries(providers)
    .filter(([id, config]) => {
      const last = health[id];
      return isLocalProvider(config) && last?.status === 'error' && now - last.checkedAt > RECHECK_LOCAL_AFTER_MS;
    })
    .map(([id]) => id);
  if (providerIds.length) await refreshSoon({ providerIds });
}

chrome.runtime?.onConnect?.addListener(port => {
  if (port.name !== 'side-panel-connection' || port.sender?.id !== chrome.runtime.id) return;
  void recheckFailedLocal().catch(error => logger.warning('Rechecking local models', toAppError(error).kind));
});

// ── Commands ──────────────────────────────────────────────────────────────────────────────────────

registerCommand('models_refresh', refreshSchema, (input, context) =>
  answer(context, 'models_refresh_started', async () => {
    const at = Date.now();
    await refreshSoon({ probeLocal: true, providerIds: input.providerIds });
    return { at };
  }),
);

registerCommand('models_provider_save', saveSchema, (input, context) =>
  answer(context, 'models_provider_saved', () => saveProvider(input)),
);

registerCommand('models_provider_check', checkSchema, (input, context) =>
  answer(context, 'models_provider_checked', () => checkSavedOrDraft(input)),
);

registerCommand('models_provider_remove', removeSchema, (input, context) =>
  answer(context, 'models_provider_removed', () => removeProvider(input)),
);

registerCommand('models_test_model', testModelSchema, (input, context) =>
  answer(context, 'models_model_tested', () => testModel(input)),
);

registerCommand('models_local_report', localReportSchema, (_input, context) =>
  answer(context, 'models_local_reported', () => localReport()),
);

registerCommand('models_local_probe', localProbeSchema, (_input, context) =>
  answer(context, 'models_local_probed', () => localProbe()),
);

registerCommand('models_light_route', lightRouteSchema, (_input, context) =>
  answer(context, 'models_light_routed', async () => {
    // Asked from the page, perhaps right after the user started a server: look again
    forgetLocalChecks();
    return { route: await lightRoute() };
  }),
);

// ── Offscreen document ────────────────────────────────────────────────────────────────────────────
// (The settings page reaches models_ commands on the settings port: ../settings/port.ts.)

// The offscreen document asks for a Live token for each connection, so the key never reaches it
chrome.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'models_live_token') return;
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('offscreen.html')) return;
  // One use, locked to the Live model in settings: a leaked token opens nothing else
  meetingSettingsStore
    .getSettings()
    .then(settings => liveTokenFromSettings({ uses: 1, model: settings.liveModel }))
    .then(token => sendResponse({ ok: true, ...token }))
    .catch(error => sendResponse({ ok: false, error: toAppError(error).message }));
  return true;
});

// Ollama and LM Studio on this machine answer the extension with no OLLAMA_ORIGINS to set
keepLocalServerRules();
