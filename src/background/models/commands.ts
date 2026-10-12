import { z } from 'zod';
import { applyGeminiDefaults, db, llmProviderStore, modelHealthStore, ProviderTypeEnum } from '@extension/storage';
import type { ProviderConfig, ProviderHealth } from '@extension/storage';
import { toAppError } from '@extension/shared';
import type { CommandContext } from '../registry';
import { createLogger } from '../log';
import { applyCheck, checkProvider } from './catalog';

/**
 * The Models page's commands: everything that touches a key or the network goes through the background.
 * Inputs are checked by zod before a handler sees them; a key is never logged or sent back.
 */

const logger = createLogger('Models');

// An interactive check gives up sooner than the background refresh, so the page hears back in time
const INTERACTIVE_RETRY = { attempts: 2 };

const providerId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w.-]+$/);
const requestId = z.string().max(100).optional();
const httpUrl = z
  .string()
  .max(500)
  .refine(value => {
    if (!value.trim()) return true;
    try {
      return ['http:', 'https:'].includes(new URL(value.trim()).protocol);
    } catch {
      return false;
    }
  }, 'Not a web address');

const providerFields = z.object({
  name: z.string().max(100).optional(),
  type: z.enum(Object.values(ProviderTypeEnum) as [ProviderTypeEnum, ...ProviderTypeEnum[]]),
  baseUrl: httpUrl.optional(),
  modelNames: z.array(z.string().min(1).max(200)).max(500).optional(),
  azureDeploymentNames: z.array(z.string().min(1).max(200)).max(100).optional(),
  azureApiVersion: z.string().max(50).optional(),
  createdAt: z.number().optional(),
});

export const refreshSchema = z.object({
  type: z.literal('models_refresh'),
  requestId,
  providerIds: z.array(providerId).max(50).optional(),
});

export const saveSchema = z.object({
  type: z.literal('models_provider_save'),
  requestId,
  providerId,
  config: providerFields,
  // A new key; empty keeps the saved one
  apiKey: z.string().max(4000).optional(),
  removeKey: z.boolean().optional(),
  // List the provider's models with the key after saving (default)
  check: z.boolean().optional(),
});

export const checkSchema = z.object({
  type: z.literal('models_provider_check'),
  requestId,
  providerId,
  // Settings being edited, not saved yet; without them the saved provider is checked
  config: providerFields.optional(),
  apiKey: z.string().max(4000).optional(),
});

export const removeSchema = z.object({
  type: z.literal('models_provider_remove'),
  requestId,
  providerId,
});

/** Runs a handler and answers its request: the reply, or a plain error the page shows. */
export async function answer(
  context: CommandContext,
  type: string,
  work: () => Promise<Record<string, unknown>>,
): Promise<void> {
  try {
    context.reply({ type, requestId: context.requestId, ...(await work()) });
  } catch (thrown) {
    const error = toAppError(thrown);
    logger.warning(`${type} failed (${error.kind})`);
    context.reply({ type: 'error', requestId: context.requestId, error: error.message });
  }
}

/** What the page may see of a check: the health and a few model names, never the key. */
function checkReply(health: ProviderHealth, models: string[]) {
  return { health, models: models.length, sample: models.slice(0, 8) };
}

export async function saveProvider(input: z.infer<typeof saveSchema>): Promise<Record<string, unknown>> {
  const { providerId: id, config } = input;
  await llmProviderStore.setProvider(id, {
    ...config,
    apiKey: input.removeKey ? '' : (input.apiKey ?? ''),
    hasKey: input.removeKey ? false : undefined,
  });

  let health: ProviderHealth | null = null;
  let listed: string[] = [];
  const saved = await llmProviderStore.getProvider(id);
  if (saved && input.check !== false) {
    const check = await checkProvider(id, saved, { retryPolicy: INTERACTIVE_RETRY });
    await applyCheck(check);
    await modelHealthStore.setProviders({ [id]: check.health });
    health = check.health;
    listed = check.entries.map(entry => entry.model);
  }

  // Agents without a model get Gemini's defaults, so a Gemini key is enough to start; a refused key gets none,
  // and only models this key can call are used (a key that could not be checked keeps the saved list)
  let assigned: Record<string, unknown> = {};
  if (config.type === ProviderTypeEnum.Gemini && saved?.apiKey && health?.hint !== 'key_rejected') {
    const names = saved.modelNames ?? [];
    const usable = health?.status === 'ok' ? names.filter(name => listed.includes(name)) : names;
    assigned = await applyGeminiDefaults(id, usable);
  }
  const summary = (await llmProviderStore.getProviderSummaries())[id];
  return {
    providerId: id,
    hasKey: Boolean(summary?.hasKey),
    keyLast4: summary?.keyLast4 ?? '',
    ...(health ? checkReply(health, listed) : { health: null }),
    assigned,
  };
}

export async function checkSavedOrDraft(input: z.infer<typeof checkSchema>): Promise<Record<string, unknown>> {
  const saved = await llmProviderStore.getProvider(input.providerId);
  const draft = Boolean(input.config || input.apiKey?.trim());
  const config: ProviderConfig | undefined = input.config
    ? { ...saved, ...input.config, apiKey: input.apiKey?.trim() || saved?.apiKey || '' }
    : saved && { ...saved, apiKey: input.apiKey?.trim() || saved.apiKey };
  if (!config) throw new Error('This provider is not set up.');
  const check = await checkProvider(input.providerId, config, { retryPolicy: INTERACTIVE_RETRY });
  // Checking what is saved also refreshes its models; a draft is only tried
  if (!draft && saved) {
    await applyCheck(check);
    await modelHealthStore.setProviders({ [input.providerId]: check.health });
  }
  return {
    providerId: input.providerId,
    ...checkReply(
      check.health,
      check.entries.map(entry => entry.model),
    ),
  };
}

export async function removeProvider(input: z.infer<typeof removeSchema>): Promise<Record<string, unknown>> {
  await llmProviderStore.removeProvider(input.providerId);
  await db.modelCatalog.where('providerId').equals(input.providerId).delete();
  await modelHealthStore.setProviders({ [input.providerId]: null });
  return { providerId: input.providerId };
}
