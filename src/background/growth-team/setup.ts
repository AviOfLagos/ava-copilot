import { t } from '@extension/i18n';
import { AppError } from '@extension/shared';
import { llmProviderStore, modelSettingsStore, ProviderTypeEnum, productStore } from '@extension/storage';
import { addInboxItem } from '../inbox/store';

/**
 * Making a growth agent (docs/growth-team.md, Part 8, "Models"). It works for one product, so it needs a workspace
 * that has one. With a Claude key in the settings it gets its models: Sonnet for daily judgement (`smart`) and
 * Haiku for sorting (`fast`); the Monday plan asks for Opus itself. Without one it falls back to the user's own
 * `smart` and `fast` roles, and the Inbox says so once.
 */

export const GROWTH_MODELS = {
  daily: 'claude-sonnet-5-5',
  sorting: 'claude-haiku-5-5',
  weekly: 'claude-opus-5-5',
} as const;

/** Refuses a growth agent outside a workspace that has a product. */
export async function checkGrowthWorkspace(workspaceId: string | null): Promise<void> {
  const profile = workspaceId ? await productStore.forWorkspace(workspaceId) : null;
  if (!profile) {
    throw new AppError('invalid', t('growth_setup_needsProduct'));
  }
}

/** The id of a configured Claude provider, or null. */
export async function claudeProviderId(): Promise<string | null> {
  const providers = await llmProviderStore.getAllProviders().catch(() => ({}));
  const found = Object.entries(providers).find(
    ([id, config]) => (config.type ?? id) === ProviderTypeEnum.Anthropic && Boolean(config.apiKey),
  );
  return found?.[0] ?? null;
}

/** Sets a new growth agent's models, or says once that it uses the user's own roles. */
export async function setGrowthModels(agentId: string): Promise<'claude' | 'fallback'> {
  const providerId = await claudeProviderId();
  if (!providerId) {
    await addInboxItem({
      source: 'system',
      externalId: 'growth-models-fallback',
      kind: 'result',
      title: t('growth_models_fallback_title'),
      body: t('growth_models_fallback_body'),
      priority: 'low',
      workspaceId: null,
      agentId: null,
    }).catch(() => undefined);
    return 'fallback';
  }
  await modelSettingsStore.setRole('smart', { providerId, model: GROWTH_MODELS.daily }, { agentId });
  await modelSettingsStore.setRole('fast', { providerId, model: GROWTH_MODELS.sorting }, { agentId });
  return 'claude';
}
