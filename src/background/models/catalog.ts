import {
  db as defaultDb,
  getProviderTypeByProviderId,
  isKeyOptional,
  isLocalProvider,
  llmProviderStore,
  localDay,
  modelHealthStore,
  modelSettingsStore,
  ProviderTypeEnum,
} from '@extension/storage';
import type {
  AviCopilotDb,
  LocalServerProbe,
  ModelCatalogEntry,
  ProviderConfig,
  ProviderHealth,
  ProviderHint,
} from '@extension/storage';
import { AppError, toAppError } from '@extension/shared';
import type { RetryPolicy } from '@extension/shared';
import { createLogger } from '../log';
import { priceFor } from '../usage/pricing';
import { fetchJson } from './http';
import {
  listProviderModels,
  LM_STUDIO_LOCAL_URL,
  OLLAMA_LOCAL_URL,
  parseOllamaTags,
  parseOpenAIModels,
} from './discovery';
import type { DiscoveredModel } from './discovery';

/**
 * The model registry: lists what every configured provider offers into `db.modelCatalog`, and records each
 * provider's health. Runs as a job (on start, every 6 hours, when a provider or key changes, on demand).
 */

const logger = createLogger('Models');

export interface RefreshOptions {
  // Only these providers; the others keep their entries
  providerIds?: string[];
  // Also look for Ollama and LM Studio on this machine when they are not set up yet
  probeLocal?: boolean;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  retryPolicy?: Partial<RetryPolicy>;
  db?: AviCopilotDb;
  now?: () => number;
}

export interface ProviderCheck {
  providerId: string;
  entries: ModelCatalogEntry[];
  health: ProviderHealth;
}

/** A plain sentence for what went wrong, never the provider's own words (they could echo a key). */
function sentenceFor(error: AppError, hint: ProviderHint | null): string {
  if (hint === 'ollama_origins')
    return 'Ollama refused the extension. Start it with OLLAMA_ORIGINS=chrome-extension://*';
  if (hint === 'needs_key') return 'This provider needs an API key.';
  if (hint === 'key_rejected') return 'The provider refused the API key.';
  if (hint === 'unreachable') return 'Nothing answered at this address.';
  switch (error.kind) {
    case 'rate_limit':
    case 'quota':
      return 'The provider is limiting requests right now.';
    case 'not_found':
      return 'This address has no model list.';
    case 'unavailable':
      return 'The provider is down right now.';
    default:
      return 'The model list could not be read.';
  }
}

function hintFor(error: AppError, type: ProviderTypeEnum): ProviderHint | null {
  if (type === ProviderTypeEnum.Ollama && error.status === 403) return 'ollama_origins';
  if (error.kind === 'auth' || error.kind === 'forbidden') return 'key_rejected';
  // Google answers a malformed key with 400 API_KEY_INVALID
  if (type === ProviderTypeEnum.Gemini && error.status === 400) return 'key_rejected';
  if (error.kind === 'network' || error.kind === 'timeout') return 'unreachable';
  return null;
}

export function healthFromError(thrown: unknown, type: ProviderTypeEnum, at: number): ProviderHealth {
  const error = toAppError(thrown);
  const hint = hintFor(error, type);
  return { status: 'error', checkedAt: at, models: 0, error: sentenceFor(error, hint), errorKind: error.kind, hint };
}

/** Catalog entries from a provider's list, with prices: Gemini's from the price table, local ones free. */
export function toEntries(
  providerId: string,
  config: Pick<ProviderConfig, 'type' | 'baseUrl'>,
  models: DiscoveredModel[],
  at: number,
): ModelCatalogEntry[] {
  const type = config.type ?? getProviderTypeByProviderId(providerId);
  const local = isLocalProvider({ ...config, type });
  const day = localDay(new Date(at));
  const seen = new Set<string>();
  const entries: ModelCatalogEntry[] = [];
  for (const model of models) {
    if (seen.has(model.model)) continue;
    seen.add(model.model);
    const known = type === ProviderTypeEnum.Gemini ? priceFor(model.model, day) : null;
    entries.push({
      id: `${providerId}:${model.model}`,
      providerId,
      model: model.model,
      label: model.label,
      local,
      contextTokens: model.contextTokens,
      inputUsdPerM: local ? 0 : (known?.input ?? model.inputUsdPerM),
      outputUsdPerM: local ? 0 : (known?.output ?? model.outputUsdPerM),
      modalities: model.modalities,
      tools: model.tools,
      health: 'ok',
      seenAt: at,
    });
  }
  return entries;
}

/**
 * Lists one provider's models with the key it has (or a key being tried), without writing anything.
 * The provider's failure comes back as its health, never thrown.
 */
export async function checkProvider(
  providerId: string,
  config: ProviderConfig,
  options: Pick<RefreshOptions, 'signal' | 'fetch' | 'retryPolicy' | 'now'> = {},
): Promise<ProviderCheck> {
  const at = options.now?.() ?? Date.now();
  const type = config.type ?? getProviderTypeByProviderId(providerId);
  if (!config.apiKey?.trim() && !isKeyOptional(type) && type !== ProviderTypeEnum.AzureOpenAI) {
    return {
      providerId,
      entries: [],
      health: {
        status: 'error',
        checkedAt: at,
        models: 0,
        error: sentenceFor(new AppError('auth', 'No key'), 'needs_key'),
        errorKind: 'auth',
        hint: 'needs_key',
      },
    };
  }
  try {
    const models = await listProviderModels(
      {
        providerId,
        type,
        apiKey: config.apiKey ?? '',
        baseUrl: config.baseUrl,
        azureDeploymentNames: config.azureDeploymentNames,
      },
      options,
    );
    // Azure is never asked: its deployments are what the user typed
    const status: 'ok' | 'unknown' = type === ProviderTypeEnum.AzureOpenAI ? 'unknown' : 'ok';
    const entries = toEntries(providerId, config, models, at).map(entry => ({ ...entry, health: status }));
    return {
      providerId,
      entries,
      health: { status, checkedAt: at, models: entries.length, error: null, errorKind: null, hint: null },
    };
  } catch (thrown) {
    const health = healthFromError(thrown, type, at);
    // An endpoint without a model list may still answer chats: unknown, not down
    if (health.errorKind === 'not_found') health.status = 'unknown';
    return { providerId, entries: [], health };
  }
}

/** Puts one provider's check into the catalog: its list replaces the old one, a failure marks the old one. */
export async function applyCheck(check: ProviderCheck, database: AviCopilotDb = defaultDb): Promise<void> {
  await database.transaction('rw', database.modelCatalog, async () => {
    const existing = (await database.modelCatalog
      .where('providerId')
      .equals(check.providerId)
      .primaryKeys()) as string[];
    if (check.health.status === 'error') {
      if (existing.length) {
        await database.modelCatalog.where('providerId').equals(check.providerId).modify({ health: 'error' });
      }
      return;
    }
    const keep = new Set(check.entries.map(entry => entry.id));
    await database.modelCatalog.bulkDelete(existing.filter(id => !keep.has(id)));
    await database.modelCatalog.bulkPut(check.entries);
  });
}

/** Looks for Ollama and LM Studio on this machine, for the "found on this Mac" offer. Never throws. */
export async function probeLocalServers(
  options: Pick<RefreshOptions, 'signal' | 'fetch' | 'now'> = {},
): Promise<LocalServerProbe[]> {
  const at = options.now?.() ?? Date.now();
  const probe = async (
    kind: LocalServerProbe['kind'],
    baseUrl: string,
    url: string,
    names: (body: unknown) => string[],
  ): Promise<LocalServerProbe> => {
    try {
      const body = await fetchJson<unknown>(url, {
        retry: false,
        timeoutMs: 3000,
        signal: options.signal,
        fetch: options.fetch,
      });
      return { kind, baseUrl, status: 'found', models: names(body).slice(0, 50), checkedAt: at };
    } catch (thrown) {
      const error = toAppError(thrown);
      // Ollama answers a page it does not trust with 403: it is there, and needs OLLAMA_ORIGINS
      const refused = error.status === 403 || error.kind === 'forbidden';
      return { kind, baseUrl, status: refused ? 'refused' : 'absent', models: [], checkedAt: at };
    }
  };
  return Promise.all([
    probe('ollama', `${OLLAMA_LOCAL_URL}/v1`, `${OLLAMA_LOCAL_URL}/api/tags`, body =>
      parseOllamaTags(body as Parameters<typeof parseOllamaTags>[0]).map(model => model.model),
    ),
    probe('lmstudio', LM_STUDIO_LOCAL_URL, `${LM_STUDIO_LOCAL_URL}/models`, body =>
      parseOpenAIModels(body as Parameters<typeof parseOpenAIModels>[0], ProviderTypeEnum.LMStudio).map(
        model => model.model,
      ),
    ),
  ]);
}

export interface RefreshReport {
  checked: ProviderCheck[];
  local: LocalServerProbe[];
}

/**
 * Refreshes the catalog: every configured provider (or the ones asked for) is listed in parallel, its
 * entries replaced and its health recorded; providers that were removed leave the catalog.
 */
export async function refreshCatalog(options: RefreshOptions = {}): Promise<RefreshReport> {
  const database = options.db ?? defaultDb;
  const now = options.now ?? Date.now;
  // Decrypted here, in the background, and only handed to the provider's own address
  const providers = await llmProviderStore.getAllProviders();
  const ids = Object.keys(providers).filter(id => !options.providerIds || options.providerIds.includes(id));

  const checked = await Promise.all(ids.map(id => checkProvider(id, providers[id], { ...options, now })));
  for (const check of checked) {
    options.signal?.throwIfAborted();
    await applyCheck(check, database);
  }

  // Providers no longer configured leave the catalog and the health record
  const configured = new Set(Object.keys(providers));
  const stale = (await database.modelCatalog.toArray()).filter(entry => !configured.has(entry.providerId));
  if (stale.length) await database.modelCatalog.bulkDelete(stale.map(entry => entry.id));
  const health = await modelHealthStore.getHealth();
  const updates: Record<string, ProviderHealth | null> = Object.fromEntries(
    checked.map(check => [check.providerId, check.health]),
  );
  for (const providerId of Object.keys(health.providers)) {
    if (!configured.has(providerId)) updates[providerId] = null;
  }
  await modelHealthStore.setProviders(updates, now());

  let local: LocalServerProbe[] = [];
  if (options.probeLocal) {
    local = await probeLocalServers({ ...options, now });
    for (const probe of local) await modelHealthStore.setLocal(probe);
    await modelSettingsStore.updateSettings({ localProbeDone: true });
  }

  const failed = checked.filter(check => check.health.status === 'error');
  logger.info(
    `Model list refreshed: ${checked.length - failed.length} of ${checked.length} providers answered` +
      (failed.length ? ` (${failed.map(check => `${check.providerId}: ${check.health.errorKind}`).join(', ')})` : ''),
  );
  return { checked, local };
}
