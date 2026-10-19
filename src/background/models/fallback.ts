import { t } from '@extension/i18n';
import {
  db,
  getDefaultDisplayNameFromProviderId,
  llmProviderStore,
  modelHealthStore,
  modelSettingsStore,
  pickFallbackModel,
} from '@extension/storage';
import { createChatModel } from '../llm/providers';
import type { ChatModel, FallbackReason } from '../llm/types';
import { createLogger } from '../log';
import { meterModel } from '../usage/meter';
import type { UsageScope } from '../usage/meter';
import { localServerAnswers } from './alive';

/**
 * A local model when the cloud fails: a cloud chat model gets a `fallback` that `callWithFallback`
 * (llm/generate.ts) uses when a call ends in a key, quota, rate-limit, outage, network or timeout error. The
 * local model is the one in Models → Local ("When the cloud fails"), checked to be running at the moment of the
 * failure. Its calls are metered as its own, so usage shows the model that answered. Only which model thinks
 * changes: every action still passes the gate.
 */

const logger = createLogger('ModelFallback');

type MessageKey = Parameters<typeof t>[0];

const REASON_KEY: Record<FallbackReason, MessageKey> = {
  auth: 'models_fallback_reason_auth',
  forbidden: 'models_fallback_reason_auth',
  quota: 'models_fallback_reason_quota',
  rate_limit: 'models_fallback_reason_rateLimit',
  unavailable: 'models_fallback_reason_unavailable',
  network: 'models_fallback_reason_network',
  timeout: 'models_fallback_reason_timeout',
};

/** The metered fallback model, or null when it is off, none is found, or its server does not answer now. */
export async function fallbackChatModel(scope: UsageScope, fetchFn?: typeof fetch): Promise<ChatModel | null> {
  const [providers, catalog, health, settings] = await Promise.all([
    llmProviderStore.getProviderSummaries(),
    db.modelCatalog.toArray(),
    modelHealthStore.getHealth(),
    modelSettingsStore.getSettings(),
  ]);
  const choice = pickFallbackModel({ providers, catalog, health: health.providers, settings, activeOnly: true });
  if (!choice) return null;
  const summary = providers[choice.providerId];
  if (!summary || !(await localServerAnswers(choice.providerId, summary, fetchFn))) {
    logger.info(`The fallback model's server does not answer (${choice.providerId})`);
    return null;
  }
  const provider = await llmProviderStore.getProvider(choice.providerId);
  if (!provider) return null;
  // Counted as the work it does, not as light work
  return meterModel(createChatModel(provider, { provider: choice.providerId, modelName: choice.model }), {
    ...scope,
    light: undefined,
    savedAgainst: undefined,
  });
}

/** The note in the chat: "Gemini failed (quota). Finishing with qwen3:4b on this computer." */
export function fallbackNote(providerName: string, reason: FallbackReason, localModel: string): string {
  return t('models_fallback_note', [providerName, t(REASON_KEY[reason]), localModel]);
}

/**
 * Gives a cloud chat model the local fallback; a local one is returned as it is. The note goes to the scope's
 * status line (the chat or run), once, after the local model's first answer. `role` is the usage role when it is
 * not the scope's own.
 */
export function withCloudFallback(
  chatModel: ChatModel,
  {
    local,
    scope,
    role,
    fetchFn,
  }: { local: boolean; scope: UsageScope; role?: UsageScope['role']; fetchFn?: typeof fetch },
): ChatModel {
  if (local) return chatModel;
  let providerName = getDefaultDisplayNameFromProviderId(chatModel.provider);
  chatModel.fallback = {
    resolve: async () => {
      const summary = (await llmProviderStore.getProviderSummaries())[chatModel.provider];
      if (summary?.name) providerName = summary.name;
      // The scope is read now, not when the model was made: a run sets its status line after building its models
      const fallback = await fallbackChatModel({ ...scope, role: role ?? scope.role }, fetchFn);
      if (!fallback || (fallback.provider === chatModel.provider && fallback.modelName === chatModel.modelName)) {
        return null;
      }
      return fallback;
    },
    onSwitch: (to, reason) => {
      logger.info(`Finishing on ${to.provider}/${to.modelName} after ${chatModel.provider} failed (${reason})`);
      scope.notify(fallbackNote(providerName, reason, to.modelName));
    },
  };
  return chatModel;
}
