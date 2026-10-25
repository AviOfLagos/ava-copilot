// "Update available": checks Ava Copilot's own site (../update/check.ts) every 12 hours and at browser start,
// then tells the user one way that is hard to miss (the panel's banner, a dot on Settings › Help, one
// notification per new version) and one that does not fight the setup checklist for the toolbar — this uses
// the toolbar's *tooltip* (chrome.action.setTitle), never setBadgeText, which the Inbox already owns
// (src/background/inbox/badge.ts) and the setup checklist is also using.
// Needs one import line in ../registers.ts: `import './update/register';`
import { z } from 'zod';
import { toAppError } from '@extension/shared';
import { t } from '@extension/i18n';
import { fetchVersionInfo } from './check';
import { createLogger } from '../log';
import { jobs, registerJobHandler } from '../jobs/runner';
import { registerCommand, registerRecovery } from '../registry';
import { brainStatusStore } from '../companion/state';
import { isNewerVersion } from './semver';
import { updateSettingsStore, updateStatusStore } from './state';
import type { UpdateStatus } from './state';

const logger = createLogger('Update');

export const UPDATE_CHECK_JOB = 'update_check';
const CRON_KEY = 'update:cron';
const STARTUP_KEY = 'update:startup';
// Every 12 hours; a check missed because the browser was closed catches up within a day instead of running late
const CRON = '0 */12 * * *';
const CRON_CATCH_UP_MS = 24 * 3600_000;
// How soon after a real browser start (not every service-worker wake) the first check runs
const STARTUP_DELAY_MS = 20_000;

async function refreshToolbarTitle(status: UpdateStatus): Promise<void> {
  const name = t('app_metadata_name');
  const title = status.extensionUpdateAvailable ? t('update_toolbar_title', [name]) : name;
  await chrome.action.setTitle({ title }).catch(() => {});
}

/** One notification per new version: a repeat check that finds the same version again sends nothing. */
async function notifyOnce(version: string): Promise<void> {
  const status = await updateStatusStore.getStatus();
  if (status.notifiedVersion === version) return;
  await chrome.notifications
    .create(`update:${version}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon-128.png'),
      title: t('update_notify_title', [t('app_metadata_name'), version]),
      message: t('update_notify_body'),
      priority: 1,
    })
    .catch(() => {});
  await updateStatusStore.update({ notifiedVersion: version });
}

/**
 * Reads the feed, compares both versions against what is actually installed, remembers the result and
 * refreshes the toolbar tooltip. `manual` (the Settings "Check now" button) runs even while the setting is off.
 */
export async function runCheck(options: { manual?: boolean } = {}): Promise<UpdateStatus> {
  const settings = await updateSettingsStore.getSettings();
  if (!settings.checkEnabled && !options.manual) return updateStatusStore.getStatus();

  try {
    const info = await fetchVersionInfo();
    const localExtensionVersion = chrome.runtime.getManifest().version;
    const localBrainVersion = (await brainStatusStore.getStatus()).version;
    const extensionUpdateAvailable = isNewerVersion(info.version, localExtensionVersion);
    const brainUpdateAvailable = Boolean(localBrainVersion) && isNewerVersion(info.brain.version, localBrainVersion!);
    const next = await updateStatusStore.update({
      checkedAt: Date.now(),
      error: null,
      info,
      extensionUpdateAvailable,
      brainUpdateAvailable,
      brainVersion: localBrainVersion,
    });
    await refreshToolbarTitle(next);
    if (extensionUpdateAvailable) await notifyOnce(info.version);
    return next;
  } catch (error) {
    const appError = toAppError(error);
    logger.warning(`Update check failed (${appError.kind})`);
    const next = await updateStatusStore.update({ checkedAt: Date.now(), error: appError.message });
    await refreshToolbarTitle(next);
    return next;
  }
}

registerJobHandler(UPDATE_CHECK_JOB, async () => {
  await runCheck();
});

registerRecovery('update', async () => {
  await jobs.schedule({ kind: UPDATE_CHECK_JOB, key: CRON_KEY, cron: CRON, catchUpMs: CRON_CATCH_UP_MS });
});

// A real browser start (not every service-worker wake, which would be far more often than "at browser start";
// the recurring 12-hour schedule above is reinstated on every wake by registerRecovery, this is just the extra
// "also check right away" the first time the browser opens)
chrome.runtime.onStartup.addListener(() => {
  void jobs
    .schedule({ kind: UPDATE_CHECK_JOB, key: STARTUP_KEY, runAt: Date.now() + STARTUP_DELAY_MS })
    .catch(() => {});
});
// onStartup never fires for a fresh install or an update/reload of the extension itself; this covers those
chrome.runtime.onInstalled.addListener(() => {
  void jobs
    .schedule({ kind: UPDATE_CHECK_JOB, key: STARTUP_KEY, runAt: Date.now() + STARTUP_DELAY_MS })
    .catch(() => {});
});

/** A panel command: its result is the reply; a failure becomes a plain sentence. */
function command<S extends z.ZodType>(
  type: string,
  schema: S,
  run: (input: z.infer<S>) => Promise<Record<string, unknown> | void>,
): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      const result = (await run(input)) ?? {};
      context.reply({ type: 'update_ok', requestId: context.requestId, ...result });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
    }
  });
}

const state = async () => ({
  settings: await updateSettingsStore.getSettings(),
  status: await updateStatusStore.getStatus(),
  localVersion: chrome.runtime.getManifest().version,
});

command('update_get_state', z.object({}), state);

command('update_check_now', z.object({}), async () => {
  await runCheck({ manual: true });
  return state();
});

command('update_set_enabled', z.object({ checkEnabled: z.boolean() }), async ({ checkEnabled }) => {
  await updateSettingsStore.update({ checkEnabled });
  return state();
});

command('update_dismiss_banner', z.object({ version: z.string().max(20) }), async ({ version }) => {
  await updateStatusStore.update({ bannerDismissedVersion: version });
  return state();
});
