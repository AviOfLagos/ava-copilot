import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';
import { deleteSecret, getSecret, isBackgroundContext, isMaskedKey, maskKey, putSecret, visibleTail } from '../secrets';
import { llmProviderModelNames, ProviderTypeEnum } from './types';
import type { ReasoningEffort } from './agentModels';

const AZURE_API_VERSION = '2025-04-01-preview';

export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const LM_STUDIO_BASE_URL = 'http://localhost:1234/v1';
export const OLLAMA_BASE_URL = 'http://localhost:11434/v1';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// Interface for a single provider configuration
export interface ProviderConfig {
  name?: string; // Display name in the options
  type?: ProviderTypeEnum; // Help to decide which LangChain ChatModel package to use
  /**
   * The API key, which may be empty for local models.
   * - In the background, `getProvider`/`getAllProviders` return the real key, decrypted from the vault.
   * - In extension pages they never do: a saved key reads as ••••last4, no key as ''.
   * - In storage it is '' once the key is in the vault, or a local server's placeholder ('ollama'); a key
   *   found here in plaintext is moved into the vault by the background.
   */
  apiKey: string;
  baseUrl?: string; // Optional base URL if provided // For Azure: Endpoint
  modelNames?: string[]; // Chosen model names (NOT used for Azure OpenAI)
  createdAt?: number; // Timestamp in milliseconds when the provider was created
  // Azure Specific Fields:
  azureDeploymentNames?: string[]; // Azure deployment names array
  azureApiVersion?: string;
  // The key is in the secrets vault under keyRef; only its last characters are kept here, for display
  hasKey?: boolean;
  keyLast4?: string;
  keyRef?: string;
}

// Interface for storing multiple LLM provider configurations
// The key is the provider id, which is the same as the provider type for built-in providers, but is custom for custom providers
export interface LLMKeyRecord {
  providers: Record<string, ProviderConfig>;
}

export type LLMProviderStorage = BaseStorage<LLMKeyRecord> & {
  setProvider: (providerId: string, config: ProviderConfig) => Promise<void>;
  getProvider: (providerId: string) => Promise<ProviderConfig | undefined>;
  removeProvider: (providerId: string) => Promise<void>;
  hasProvider: (providerId: string) => Promise<boolean>;
  getAllProviders: () => Promise<Record<string, ProviderConfig>>;
  /** Every provider with its key masked, in any context: for showing which keys exist. */
  getProviderSummaries: () => Promise<Record<string, ProviderConfig>>;
  /** Sets a provider's model names (its active models) and nothing else; keys are not touched. */
  setModelNames: (providerId: string, modelNames: string[]) => Promise<void>;
};

// Built-in providers that were removed (Cerebras, Llama API, Groq); their saved configs, including API keys, are deleted.
// Without this they would fall back to the OpenAI-compatible default and send their keys to api.openai.com.
const removedProviderIds = ['cerebras', 'llama', 'groq'];

// The storage key, kept as "llm-api-keys" for backward compatibility
export const LLM_PROVIDERS_STORAGE_KEY = 'llm-api-keys';

const storage = createStorage<LLMKeyRecord>(
  LLM_PROVIDERS_STORAGE_KEY,
  { providers: {} },
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

// When the keys first left plaintext storage for the vault
const migrationStorage = createStorage<{ migratedAt: number | null }>(
  'llm-api-keys-vault',
  { migratedAt: null },
  { storageEnum: StorageEnum.Local },
);

/** The vault entry holding a provider's key. */
export function providerKeyRef(providerId: string): string {
  return `llm:${providerId}`;
}

/** Deletes a key from the vault; a failure leaves an encrypted orphan behind, never stops the caller. */
async function forgetSecret(ref: string): Promise<void> {
  await deleteSecret(ref).catch(() => console.warn('[Vault] Could not delete a stored key'));
}

// Helper function to determine provider type from provider name
// Make sure to update this function if you add a new provider type
export function getProviderTypeByProviderId(providerId: string): ProviderTypeEnum {
  // Check if this is an Azure provider (either the main one or one with a custom ID)
  if (providerId === ProviderTypeEnum.AzureOpenAI) {
    return ProviderTypeEnum.AzureOpenAI;
  }

  // Handle custom Azure providers with IDs like azure_openai_2
  if (typeof providerId === 'string' && providerId.startsWith(`${ProviderTypeEnum.AzureOpenAI}_`)) {
    return ProviderTypeEnum.AzureOpenAI;
  }

  // Handle standard provider types
  switch (providerId) {
    case ProviderTypeEnum.OpenAI:
    case ProviderTypeEnum.Anthropic:
    case ProviderTypeEnum.DeepSeek:
    case ProviderTypeEnum.Gemini:
    case ProviderTypeEnum.Grok:
    case ProviderTypeEnum.Ollama:
    case ProviderTypeEnum.OpenRouter:
    case ProviderTypeEnum.Nvidia:
    case ProviderTypeEnum.LMStudio:
      return providerId;
    default:
      return ProviderTypeEnum.CustomOpenAI;
  }
}

// Helper function to get display name from provider id
// Make sure to update this function if you add a new provider type
export function getDefaultDisplayNameFromProviderId(providerId: string): string {
  switch (providerId) {
    case ProviderTypeEnum.OpenAI:
      return 'OpenAI';
    case ProviderTypeEnum.Anthropic:
      return 'Anthropic';
    case ProviderTypeEnum.DeepSeek:
      return 'DeepSeek';
    case ProviderTypeEnum.Gemini:
      return 'Gemini';
    case ProviderTypeEnum.Grok:
      return 'Grok';
    case ProviderTypeEnum.Ollama:
      return 'Ollama';
    case ProviderTypeEnum.AzureOpenAI:
      return 'Azure OpenAI';
    case ProviderTypeEnum.OpenRouter:
      return 'OpenRouter';
    case ProviderTypeEnum.Nvidia:
      return 'NVIDIA NIM';
    case ProviderTypeEnum.LMStudio:
      return 'LM Studio';
    default:
      return providerId; // Use the provider id as display name for custom providers by default
  }
}

/** Providers whose models answer on the OpenAI chat-completions API at a base URL (createChatModel's default path). */
export function isOpenAICompatibleType(type: ProviderTypeEnum | undefined): boolean {
  return (
    type === ProviderTypeEnum.CustomOpenAI || type === ProviderTypeEnum.Nvidia || type === ProviderTypeEnum.LMStudio
  );
}

/** Providers that work without an API key: local servers and custom endpoints. */
export function isKeyOptional(type: ProviderTypeEnum | undefined): boolean {
  return (
    type === ProviderTypeEnum.Ollama || type === ProviderTypeEnum.LMStudio || type === ProviderTypeEnum.CustomOpenAI
  );
}

/** Providers that take a base URL in their settings. */
export function takesBaseUrl(type: ProviderTypeEnum | undefined): boolean {
  return (
    type === ProviderTypeEnum.CustomOpenAI ||
    type === ProviderTypeEnum.Ollama ||
    type === ProviderTypeEnum.AzureOpenAI ||
    type === ProviderTypeEnum.OpenRouter ||
    type === ProviderTypeEnum.Nvidia ||
    type === ProviderTypeEnum.LMStudio
  );
}

/**
 * The stand-in key a local server takes. It guards nothing, so it is not a secret and stays in plain storage
 * (an LM Studio provider with it also passes the panel's "has a key" check).
 */
export function isPlaceholderKey(type: ProviderTypeEnum | undefined, key: string | undefined): boolean {
  const value = key?.trim();
  return (
    (type === ProviderTypeEnum.Ollama && value === 'ollama') ||
    (type === ProviderTypeEnum.LMStudio && value === 'lm-studio')
  );
}

/** Whether a provider has a key, from any context: a key in the vault, a placeholder, or (before migration) plaintext. */
export function providerHasKey(config: Pick<ProviderConfig, 'apiKey' | 'hasKey'> | undefined): boolean {
  return Boolean(config && (config.hasKey || config.apiKey?.trim()));
}

/** Whether a provider can be called: it has a key, or needs none. */
export function providerIsUsable(config: ProviderConfig | undefined, providerId = ''): boolean {
  if (!config) return false;
  return providerHasKey(config) || isKeyOptional(config.type ?? getProviderTypeByProviderId(providerId));
}

/**
 * Whether a provider runs on this machine: Ollama, LM Studio, or a custom endpoint on localhost. A named cloud
 * service (OpenRouter, NVIDIA…) stays cloud even behind a local proxy: its calls still cost money.
 */
export function isLocalProvider(config: Pick<ProviderConfig, 'type' | 'baseUrl'> | undefined): boolean {
  if (!config) return false;
  if (config.type === ProviderTypeEnum.Ollama || config.type === ProviderTypeEnum.LMStudio) return true;
  return (config.type ?? ProviderTypeEnum.CustomOpenAI) === ProviderTypeEnum.CustomOpenAI && isLocalUrl(config.baseUrl);
}

export function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return (
      host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host.endsWith('.local')
    );
  } catch {
    return false;
  }
}

// Get default configuration for built-in providers
export function getDefaultProviderConfig(providerId: string): ProviderConfig {
  switch (providerId) {
    case ProviderTypeEnum.OpenAI:
    case ProviderTypeEnum.Anthropic:
    case ProviderTypeEnum.DeepSeek:
    case ProviderTypeEnum.Gemini:
    case ProviderTypeEnum.Grok:
    case ProviderTypeEnum.OpenRouter: // OpenRouter uses modelNames
    case ProviderTypeEnum.Nvidia:
      return {
        apiKey: '',
        name: getDefaultDisplayNameFromProviderId(providerId),
        type: providerId,
        baseUrl:
          providerId === ProviderTypeEnum.OpenRouter
            ? OPENROUTER_BASE_URL
            : providerId === ProviderTypeEnum.Nvidia
              ? NVIDIA_BASE_URL
              : undefined,
        modelNames: [...(llmProviderModelNames[providerId] || [])],
        createdAt: Date.now(),
      };

    case ProviderTypeEnum.Ollama:
      return {
        apiKey: 'ollama', // Set default API key for Ollama
        name: getDefaultDisplayNameFromProviderId(ProviderTypeEnum.Ollama),
        type: ProviderTypeEnum.Ollama,
        modelNames: llmProviderModelNames[providerId],
        baseUrl: OLLAMA_BASE_URL,
        createdAt: Date.now(),
      };
    case ProviderTypeEnum.LMStudio:
      return {
        // LM Studio takes any key unless the user turned authentication on
        apiKey: 'lm-studio',
        name: getDefaultDisplayNameFromProviderId(ProviderTypeEnum.LMStudio),
        type: ProviderTypeEnum.LMStudio,
        modelNames: [],
        baseUrl: LM_STUDIO_BASE_URL,
        createdAt: Date.now(),
      };
    case ProviderTypeEnum.AzureOpenAI:
      return {
        apiKey: '', // User needs to provide API Key
        name: getDefaultDisplayNameFromProviderId(ProviderTypeEnum.AzureOpenAI),
        type: ProviderTypeEnum.AzureOpenAI,
        baseUrl: '', // User needs to provide Azure endpoint
        // modelNames: [], // Not used for Azure configuration
        azureDeploymentNames: [], // Azure deployment names
        azureApiVersion: AZURE_API_VERSION, // Provide a common default API version
        createdAt: Date.now(),
      };
    default: // Handles CustomOpenAI
      return {
        apiKey: '',
        name: getDefaultDisplayNameFromProviderId(providerId),
        type: ProviderTypeEnum.CustomOpenAI,
        baseUrl: '',
        modelNames: [], // Custom providers use modelNames
        createdAt: Date.now(),
      };
  }
}

/**
 * Reasoning effort used when a model has none saved. OpenRouter, Ollama and OpenAI-compatible providers
 * serve models that may not reason, so they send no effort; the other providers default to low.
 */
export function getDefaultReasoningEffort(providerType: ProviderTypeEnum | undefined): ReasoningEffort {
  switch (providerType) {
    case ProviderTypeEnum.OpenRouter:
    case ProviderTypeEnum.Ollama:
    case ProviderTypeEnum.CustomOpenAI:
    case ProviderTypeEnum.Nvidia:
    case ProviderTypeEnum.LMStudio:
    case undefined:
      return 'none';
    default:
      return 'low';
  }
}

// Helper function to ensure backward compatibility for provider configs
function ensureBackwardCompatibility(providerId: string, config: ProviderConfig): ProviderConfig {
  const updatedConfig = { ...config };

  // Ensure name exists
  if (!updatedConfig.name) {
    updatedConfig.name = getDefaultDisplayNameFromProviderId(providerId);
  }
  // Ensure type exists
  if (!updatedConfig.type) {
    updatedConfig.type = getProviderTypeByProviderId(providerId);
  }

  // Handle Azure specifics
  if (updatedConfig.type === ProviderTypeEnum.AzureOpenAI) {
    // Ensure Azure fields exist, provide defaults if missing
    if (updatedConfig.azureApiVersion === undefined) {
      updatedConfig.azureApiVersion = AZURE_API_VERSION;
    }

    // Initialize azureDeploymentNames array if it doesn't exist yet
    if (!updatedConfig.azureDeploymentNames) {
      updatedConfig.azureDeploymentNames = [];
    }

    // CRITICAL: Delete modelNames if it exists for Azure type to clean up old configs
    if (Object.prototype.hasOwnProperty.call(updatedConfig, 'modelNames')) {
      delete updatedConfig.modelNames;
    }
  } else {
    // Ensure modelNames exists ONLY for non-Azure types
    if (!updatedConfig.modelNames) {
      updatedConfig.modelNames = llmProviderModelNames[providerId as keyof typeof llmProviderModelNames] || [];
    }
  }

  // Ensure createdAt exists
  if (!updatedConfig.createdAt) {
    updatedConfig.createdAt = new Date('03/04/2025').getTime();
  }

  return updatedConfig;
}

/** The key a page may see: ••••last4 for a saved key, a local placeholder as is, or ''. */
function displayKey(config: ProviderConfig): string {
  const type = config.type;
  if (config.keyRef && config.hasKey) return maskKey(config.keyLast4);
  const plain = config.apiKey?.trim() ?? '';
  if (!plain) return '';
  if (isPlaceholderKey(type, plain)) return plain;
  // Not migrated yet: still never shown
  return maskKey(visibleTail(plain));
}

/** The config with the key a caller in this context may have. */
async function withKey(providerId: string, config: ProviderConfig, missing: string[]): Promise<ProviderConfig> {
  if (!isBackgroundContext()) return { ...config, apiKey: displayKey(config) };
  if (!config.keyRef || !config.hasKey) return config;
  const key = await getSecret(config.keyRef);
  if (key === null) missing.push(providerId);
  return { ...config, apiKey: key ?? '' };
}

/** A key the vault no longer has (its data was cleared) stops showing as saved, so the user enters it again. */
async function forgetMissingKeys(providerIds: string[]): Promise<void> {
  if (providerIds.length === 0) return;
  const current = (await storage.get()) || { providers: {} };
  const providers = { ...current.providers };
  for (const id of providerIds) {
    if (providers[id]) providers[id] = { ...providers[id], hasKey: false, keyLast4: undefined, keyRef: undefined };
  }
  await storage.set({ ...current, providers });
}

export const llmProviderStore: LLMProviderStorage = {
  ...storage,
  /**
   * Saves a provider. A new key goes to the vault (the background only); an empty or masked key keeps the
   * saved one, unless `hasKey: false` asks to remove it.
   */
  async setProvider(providerId: string, config: ProviderConfig) {
    if (!providerId) {
      throw new Error('Provider id cannot be empty');
    }

    if (config.apiKey === undefined) {
      throw new Error('API key must be provided (can be empty for local models)');
    }

    const providerType = config.type || getProviderTypeByProviderId(providerId);
    const current = (await storage.get()) || { providers: {} };
    const previous = current.providers?.[providerId];

    const typed = config.apiKey.trim();
    const placeholder = isPlaceholderKey(providerType, typed) ? typed : '';
    // A key saved before the vault, still in plaintext
    const legacyKey =
      previous && !previous.keyRef && previous.apiKey?.trim() && !isPlaceholderKey(providerType, previous.apiKey)
        ? previous.apiKey.trim()
        : '';
    let secret = typed && !placeholder && !isMaskedKey(typed) ? typed : '';
    let keepVaultKey = false;
    let keepLegacyKey = false;
    if (!secret && !placeholder && config.hasKey !== false) {
      if (previous?.keyRef && previous.hasKey) keepVaultKey = true;
      else if (legacyKey) {
        // The background moves it into the vault now; a page leaves it for the background
        if (isBackgroundContext()) secret = legacyKey;
        else keepLegacyKey = true;
      }
    }
    const hasAnyKey = Boolean(secret || placeholder || keepVaultKey || keepLegacyKey);

    if (providerType === ProviderTypeEnum.AzureOpenAI) {
      if (!config.baseUrl?.trim()) {
        throw new Error('Azure Endpoint (baseUrl) is required');
      }
      if (!config.azureDeploymentNames || config.azureDeploymentNames.length === 0) {
        throw new Error('At least one Azure Deployment Name is required');
      }
      if (!config.azureApiVersion?.trim()) {
        throw new Error('Azure API Version is required');
      }
      if (!hasAnyKey) {
        throw new Error('API Key is required for Azure OpenAI');
      }
    } else if (!isKeyOptional(providerType)) {
      if (!hasAnyKey) {
        throw new Error(`API Key is required for ${getDefaultDisplayNameFromProviderId(providerId)}`);
      }
    }

    if (providerType !== ProviderTypeEnum.AzureOpenAI) {
      if (!config.modelNames || config.modelNames.length === 0) {
        console.warn(`Provider ${providerId} of type ${providerType} is being saved without model names.`);
      }
    }

    let keyFields: Pick<ProviderConfig, 'apiKey' | 'hasKey' | 'keyLast4' | 'keyRef'>;
    if (secret) {
      if (!isBackgroundContext()) throw new Error('API keys are saved by the background.');
      const ref = providerKeyRef(providerId);
      await putSecret(ref, secret);
      keyFields = { apiKey: '', hasKey: true, keyLast4: visibleTail(secret), keyRef: ref };
    } else if (keepVaultKey) {
      keyFields = { apiKey: '', hasKey: true, keyLast4: previous?.keyLast4, keyRef: previous?.keyRef };
    } else if (keepLegacyKey) {
      keyFields = { apiKey: legacyKey, hasKey: false };
    } else {
      if (previous?.keyRef) await forgetSecret(previous.keyRef);
      keyFields = { apiKey: placeholder, hasKey: false };
    }

    const completeConfig: ProviderConfig = {
      ...keyFields,
      baseUrl: config.baseUrl,
      name: config.name || getDefaultDisplayNameFromProviderId(providerId),
      type: providerType,
      createdAt: config.createdAt || Date.now(),
      ...(providerType === ProviderTypeEnum.AzureOpenAI
        ? {
            azureDeploymentNames: config.azureDeploymentNames || [],
            azureApiVersion: config.azureApiVersion,
          }
        : {
            modelNames: config.modelNames || [],
          }),
    };

    // Never log the config: before the vault it held the API key. Re-read, so a save elsewhere is not undone
    const latest = (await storage.get()) || { providers: {} };
    await storage.set({
      ...latest,
      providers: {
        ...latest.providers,
        [providerId]: completeConfig,
      },
    });
  },
  async setModelNames(providerId: string, modelNames: string[]) {
    const latest = (await storage.get()) || { providers: {} };
    const previous = latest.providers?.[providerId];
    if (!previous) return;
    await storage.set({
      ...latest,
      providers: { ...latest.providers, [providerId]: { ...previous, modelNames: [...new Set(modelNames)] } },
    });
  },
  async getProvider(providerId: string) {
    const data = (await storage.get()) || { providers: {} };
    const config = data.providers?.[providerId];
    if (!config) return undefined;
    const missing: string[] = [];
    const result = await withKey(providerId, ensureBackwardCompatibility(providerId, config), missing);
    await forgetMissingKeys(missing);
    return result;
  },
  async removeProvider(providerId: string) {
    const current = (await storage.get()) || { providers: {} };
    const newProviders = { ...current.providers };
    delete newProviders[providerId];
    await forgetSecret(providerKeyRef(providerId));
    await storage.set({ ...current, providers: newProviders });
  },
  async hasProvider(providerId: string) {
    const data = (await storage.get()) || { providers: {} };
    return providerId in (data.providers ?? {});
  },

  async getAllProviders() {
    const data = await storage.get();
    const providers = { ...(data?.providers ?? {}) };

    if (removedProviderIds.some(id => id in providers)) {
      for (const id of removedProviderIds) {
        delete providers[id];
        await forgetSecret(providerKeyRef(id));
      }
      await storage.set({ ...data, providers: { ...providers } });
    }

    // Add backward compatibility for all providers, and the key this context may have
    const missing: string[] = [];
    for (const [providerId, config] of Object.entries(providers)) {
      providers[providerId] = await withKey(providerId, ensureBackwardCompatibility(providerId, config), missing);
    }
    await forgetMissingKeys(missing);

    return providers;
  },

  async getProviderSummaries() {
    const data = (await storage.get()) || { providers: {} };
    const summaries: Record<string, ProviderConfig> = {};
    for (const [providerId, config] of Object.entries(data.providers ?? {})) {
      if (removedProviderIds.includes(providerId)) continue;
      const compatible = ensureBackwardCompatibility(providerId, config);
      summaries[providerId] = { ...compatible, apiKey: displayKey(compatible) };
    }
    return summaries;
  },
};

/**
 * Moves every plaintext provider key into the vault: write, read back and compare, and only then blank the
 * plaintext (a key that fails stays where it was, and is tried again next time). Runs in the background, at
 * start and whenever a key shows up in plaintext again.
 *
 * @returns The providers whose keys moved, and those that could not be moved
 */
export async function migrateProviderKeys(): Promise<{ migrated: string[]; failed: string[] }> {
  if (!isBackgroundContext()) throw new Error('Keys are moved by the background.');
  const data = (await storage.get()) || { providers: {} };
  const moved = new Map<string, { key: string; ref: string }>();
  const failed: string[] = [];

  for (const [providerId, config] of Object.entries(data.providers ?? {})) {
    const key = config?.apiKey?.trim();
    const type = config?.type ?? getProviderTypeByProviderId(providerId);
    if (!key || isPlaceholderKey(type, key) || isMaskedKey(key)) continue;
    const ref = providerKeyRef(providerId);
    try {
      await putSecret(ref, key);
      if ((await getSecret(ref)) !== key) throw new Error('The key did not read back.');
      moved.set(providerId, { key, ref });
    } catch {
      // Never the key or its error text, which could quote it
      console.warn(`[Vault] Could not move the key of ${providerId}; it stays where it was for now`);
      failed.push(providerId);
    }
  }

  if (moved.size > 0) {
    // Read again: a key changed in the meantime is left for the next pass
    const latest = (await storage.get()) || { providers: {} };
    const providers = { ...latest.providers };
    for (const [providerId, { key, ref }] of moved) {
      const config = providers[providerId];
      if (!config || config.apiKey?.trim() !== key) continue;
      providers[providerId] = { ...config, apiKey: '', hasKey: true, keyLast4: visibleTail(key), keyRef: ref };
    }
    await storage.set({ ...latest, providers });
  }

  if ((await migrationStorage.get())?.migratedAt == null && failed.length === 0) {
    await migrationStorage.set({ migratedAt: Date.now() });
  }
  return { migrated: [...moved.keys()], failed };
}

/** When provider keys first moved into the vault, or null if they have not yet. */
export async function keysMigratedAt(): Promise<number | null> {
  return (await migrationStorage.get())?.migratedAt ?? null;
}

/** Whether any provider still has its key in plaintext storage. */
export async function hasPlaintextKeys(): Promise<boolean> {
  const data = (await storage.get()) || { providers: {} };
  return Object.entries(data.providers ?? {}).some(([providerId, config]) => {
    const key = config?.apiKey?.trim();
    const type = config?.type ?? getProviderTypeByProviderId(providerId);
    return Boolean(key) && !isPlaceholderKey(type, key) && !isMaskedKey(key);
  });
}
