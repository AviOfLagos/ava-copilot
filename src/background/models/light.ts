import {
  db,
  decideLightRoute,
  getProviderTypeByProviderId,
  llmProviderStore,
  modelHealthStore,
  modelSettingsStore,
  pickRoleModel,
  ProviderTypeEnum,
} from '@extension/storage';
import type { LightRoute, LightTask, ProviderConfig, RoleTarget } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { t } from '@extension/i18n';
import { createChatModel } from '../llm/providers';
import type { ChatModel } from '../llm/types';
import { createLogger } from '../log';
import { meterModel } from '../usage/meter';
import type { UsageScope } from '../usage/meter';
import { addInboxItem } from '../inbox/store';
import { ollamaRoot, providerBaseUrl } from './discovery';
import { fetchJson } from './http';
import { createRoleModel, resolveRole } from './roles';
import type { RoleScope } from './roles';

/**
 * Light work (summaries, titles, classification, routine steps, Inbox summaries, reflection) runs on a local model
 * when one is running and the user prefers it (the default). With none running, the user is told once, in the
 * Inbox, that starting Ollama would save cost or that they can allow the cloud; only then does the work use the
 * cloud's fast model. Heavy work (the browser agent, vision) never comes here.
 */

const logger = createLogger('LightModels');

// How long a "the local server answers" check is trusted
const ALIVE_TTL_MS = 60_000;
const ALIVE_TIMEOUT_MS = 1500;
const alive = new Map<string, { ok: boolean; at: number }>();

/** Forgets the local server checks (tests, or after the user starts a server). */
export function forgetLocalChecks(): void {
  alive.clear();
}

/** Whether a local provider's server answers now: a quick list request, remembered for a minute. */
export async function localServerAnswers(
  providerId: string,
  config: ProviderConfig,
  fetchFn?: typeof fetch,
): Promise<boolean> {
  const cached = alive.get(providerId);
  if (cached && Date.now() - cached.at < ALIVE_TTL_MS) return cached.ok;
  const type = config.type ?? getProviderTypeByProviderId(providerId);
  const url =
    type === ProviderTypeEnum.Ollama
      ? `${ollamaRoot(config.baseUrl)}/api/tags`
      : `${providerBaseUrl(type, config.baseUrl) ?? ''}/models`;
  let ok = false;
  try {
    await fetchJson(url, { retry: false, timeoutMs: ALIVE_TIMEOUT_MS, fetch: fetchFn });
    ok = true;
  } catch (error) {
    // A server without a model list still answers chats; one that refuses this extension (403) does not
    const status = toAppError(error).status;
    ok = status === 404 || status === 405;
  }
  alive.set(providerId, { ok, at: Date.now() });
  return ok;
}

/** The active local model to use for light work, if its server answers; null otherwise. */
export async function runningLocalModel(fetchFn?: typeof fetch): Promise<RoleTarget | null> {
  const [providers, catalog, health, settings] = await Promise.all([
    llmProviderStore.getProviderSummaries(),
    db.modelCatalog.toArray(),
    modelHealthStore.getHealth(),
    modelSettingsStore.getSettings(),
  ]);
  const choice = pickRoleModel({
    role: 'local',
    providers,
    catalog,
    health: health.providers,
    settings,
    activeOnly: true,
  });
  if (!choice || !choice.local) return null;
  const config = providers[choice.providerId];
  if (!config || !(await localServerAnswers(choice.providerId, config, fetchFn))) return null;
  return { providerId: choice.providerId, model: choice.model };
}

/** Where light work goes now, without calling any model: for the Models page and for `lightModel`. */
export async function lightRoute(fetchFn?: typeof fetch): Promise<LightRoute> {
  const settings = await modelSettingsStore.getSettings();
  const runningLocal = settings.preferLocalLight ? await runningLocalModel(fetchFn) : null;
  return decideLightRoute({
    preferLocal: settings.preferLocalLight,
    cloudAllowed: settings.lightCloudAllowed,
    noticeAt: settings.lightNoticeAt,
    runningLocal,
  });
}

/** The one-time Inbox notice: start a local model to save cost, or allow the cloud for light work. */
async function noticeOnce(): Promise<void> {
  const settings = await modelSettingsStore.getSettings();
  if (settings.lightNoticeAt !== null) return;
  await modelSettingsStore.updateSettings({ lightNoticeAt: Date.now() });
  try {
    await addInboxItem({
      source: 'models',
      externalId: 'light-local',
      kind: 'alert',
      title: t('models_light_notice_title'),
      body: t('models_light_notice_body'),
    });
  } catch (error) {
    logger.warning(`Light-work notice not added (${toAppError(error).kind})`);
  }
}

/**
 * A metered chat model for light work. `fallback` is the caller's last resort when no role can be resolved
 * (a fresh install with no catalog yet): usually the agent settings' Navigator model.
 */
export async function lightModel(
  task: LightTask,
  scope: UsageScope & RoleScope,
  fallback?: () => Promise<ChatModel>,
): Promise<{ chatModel: ChatModel; local: boolean }> {
  const route = await lightRoute().catch(() => null);
  if (route?.route === 'local') {
    const provider = await llmProviderStore.getProvider(route.target.providerId);
    if (provider) {
      // The cloud model this replaces, to count what running locally saved
      const cloud = await resolveRole('fast', scope).catch(() => null);
      const savedAgainst = cloud && !cloud.local ? { providerId: cloud.providerId, model: cloud.model } : null;
      const chatModel = meterModel(
        createChatModel(provider, { provider: route.target.providerId, modelName: route.target.model }),
        { ...scope, role: 'local', light: true, savedAgainst },
      );
      logger.info(`Light work (${task}) runs on a local model`);
      return { chatModel, local: true };
    }
  }
  if (route?.route === 'cloud' && route.notice) await noticeOnce();
  try {
    const { chatModel, choice } = await createRoleModel('fast', scope);
    return { chatModel, local: choice.local };
  } catch (error) {
    if (!fallback) throw error;
    return { chatModel: await fallback(), local: false };
  }
}
