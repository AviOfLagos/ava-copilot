import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  chatModelChoices,
  db,
  EMPTY_MODEL_HEALTH,
  getDefaultProviderConfig,
  getProviderTypeByProviderId,
  isKeyOptional,
  isLocalProvider,
  isMaskedKey,
  LLM_PROVIDERS_STORAGE_KEY,
  llmProviderModelNames,
  llmProviderStore,
  maskKey,
  modelHealthStore,
  providerHasKey,
  ProviderTypeEnum,
  takesBaseUrl,
} from '@extension/storage';
import type {
  LocalServerKind,
  ModelCatalogEntry,
  ModelHealthRecord,
  ProviderConfig,
  ProviderHealth,
} from '@extension/storage';
import type { t } from '@extension/i18n';
import { useLive } from '../hooks/useLive';

/**
 * Provider settings for the Models page in the panel and the full settings page: what is saved (keys masked),
 * edits not saved yet, and the commands that save, check and remove through the background. Keys typed here
 * go to the background once, on save, and are never read back.
 */

type MessageKey = Parameters<typeof t>[0];

/** Sends a command to the background and resolves with its reply (the panel's port or the settings page's). */
export type ModelsRequest = <T = Record<string, unknown>>(
  message: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<T>;

export interface ProviderDraft {
  // The settings being edited; apiKey here is only the masked display
  config: ProviderConfig;
  // A new key typed by the user; empty keeps the saved one
  apiKey: string;
  isNew: boolean;
}

export interface ProviderCheckResult {
  health: ProviderHealth | null;
  models: number;
  sample: string[];
}

export interface ProviderRow {
  id: string;
  type: ProviderTypeEnum;
  // The draft's settings while editing, else what is saved
  config: ProviderConfig;
  saved: ProviderConfig | null;
  draft: ProviderDraft | null;
  local: boolean;
  // A key is saved (in the vault, or not moved there yet): shown only as keyDisplay, ••••last4
  hasKey: boolean;
  keyDisplay: string;
  keyOptional: boolean;
  health: ProviderHealth | null;
  // Models the registry listed for it
  modelCount: number;
}

// Requests that list models wait for the provider, which may be slow
const CHECK_TIMEOUT_MS = 45_000;

// Built-in kinds that can be added once each; Azure and custom endpoints any number of times
const SINGLE_TYPES = Object.values(ProviderTypeEnum).filter(
  type => type !== ProviderTypeEnum.AzureOpenAI && type !== ProviderTypeEnum.CustomOpenAI,
);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The settings a save sends: everything but the key, which travels on its own. */
export function shareable(config: ProviderConfig) {
  return {
    name: config.name,
    type: config.type ?? ProviderTypeEnum.CustomOpenAI,
    baseUrl: config.baseUrl?.trim() || undefined,
    modelNames: config.type === ProviderTypeEnum.AzureOpenAI ? undefined : (config.modelNames ?? []),
    azureDeploymentNames:
      config.type === ProviderTypeEnum.AzureOpenAI ? (config.azureDeploymentNames ?? []) : undefined,
    azureApiVersion: config.type === ProviderTypeEnum.AzureOpenAI ? config.azureApiVersion : undefined,
    createdAt: config.createdAt,
  };
}

/** Sets or clears (null) one id's entry in a state record. */
function setFor<T>(
  setter: (update: (prev: Record<string, T>) => Record<string, T>) => void,
  id: string,
  value: T | null,
): void {
  setter(prev => {
    const next = { ...prev };
    if (value === null) delete next[id];
    else next[id] = value;
    return next;
  });
}

/** What stops a provider from being saved, as a message key; null when it can be. */
export function providerProblem(draft: ProviderDraft, saved: ProviderConfig | null): MessageKey | null {
  const { config } = draft;
  const type = config.type ?? ProviderTypeEnum.CustomOpenAI;
  if (type === ProviderTypeEnum.CustomOpenAI) {
    if (!config.name?.trim()) return 'models_problem_name';
    if (/\s/.test(config.name)) return 'options_models_providers_errors_spacesNotAllowed';
  }
  if (takesBaseUrl(type) && !config.baseUrl?.trim()) return 'models_problem_baseUrl';
  if (type === ProviderTypeEnum.AzureOpenAI) {
    if (!config.azureDeploymentNames?.length) return 'models_problem_deployment';
    if (!config.azureApiVersion?.trim()) return 'models_problem_apiVersion';
  }
  const keyed = Boolean(draft.apiKey.trim()) || providerHasKey(saved ?? undefined);
  if (!isKeyOptional(type) && !keyed) return 'models_problem_key';
  return null;
}

export function useProviders(request: ModelsRequest) {
  const [saved, setSaved] = useState<Record<string, ProviderConfig>>({});
  const [loaded, setLoaded] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
  const [health, setHealth] = useState<ModelHealthRecord>(EMPTY_MODEL_HEALTH);
  const [busy, setBusy] = useState<Record<string, 'saving' | 'checking' | 'removing'>>({});
  const [results, setResults] = useState<Record<string, ProviderCheckResult>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState<number | null>(null);
  const catalog = useLive(() => db.modelCatalog.toArray(), [], [] as ModelCatalogEntry[]);

  // Saved providers (keys masked) and health follow storage, whoever changes it
  useEffect(() => {
    let alive = true;
    const loadProviders = () =>
      void llmProviderStore
        .getProviderSummaries()
        .then(next => alive && (setSaved(next), setLoaded(true)))
        .catch(() => alive && setLoaded(true));
    const loadHealth = () => void modelHealthStore.getHealth().then(next => alive && setHealth(next));
    loadProviders();
    loadHealth();
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (changes[LLM_PROVIDERS_STORAGE_KEY]) loadProviders();
      if (changes['model-health']) loadHealth();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  // A refresh is over when the registry records a newer one, or after a minute
  useEffect(() => {
    if (refreshing === null) return;
    if ((health.lastRefreshAt ?? 0) >= refreshing) {
      setRefreshing(null);
      return;
    }
    const timer = window.setTimeout(() => setRefreshing(null), 60_000);
    return () => window.clearTimeout(timer);
  }, [health.lastRefreshAt, refreshing]);

  const rows = useMemo<ProviderRow[]>(() => {
    const ids = [...new Set([...Object.keys(saved), ...Object.keys(drafts)])];
    const counts = new Map<string, number>();
    for (const entry of catalog) counts.set(entry.providerId, (counts.get(entry.providerId) ?? 0) + 1);
    return ids
      .map(id => {
        const stored = saved[id] ?? null;
        const draft = drafts[id] ?? null;
        const config = draft?.config ?? stored!;
        const type = config.type ?? getProviderTypeByProviderId(id);
        return {
          id,
          type,
          config,
          saved: stored,
          draft,
          local: isLocalProvider({ ...config, type }),
          // A local server's stand-in key ('ollama') is no key
          hasKey: Boolean(stored?.hasKey) || isMaskedKey(stored?.apiKey),
          keyDisplay: isMaskedKey(stored?.apiKey) ? stored!.apiKey : stored?.hasKey ? maskKey(stored.keyLast4) : '',
          keyOptional: isKeyOptional(type),
          health: health.providers[id] ?? null,
          modelCount: counts.get(id) ?? 0,
        };
      })
      .sort((a, b) => {
        // New ones last, the rest oldest first
        if (!a.saved !== !b.saved) return a.saved ? -1 : 1;
        return (a.config.createdAt ?? 0) - (b.config.createdAt ?? 0) || a.id.localeCompare(b.id);
      });
  }, [saved, drafts, health, catalog]);

  /** Kinds that can still be added: each built-in once, Azure and custom endpoints any number of times. */
  const addableTypes = useMemo(
    () => [
      ...SINGLE_TYPES.filter(type => !(type in saved) && !(type in drafts)),
      ProviderTypeEnum.AzureOpenAI,
      ProviderTypeEnum.CustomOpenAI,
    ],
    [saved, drafts],
  );

  /** Starts a new provider of a kind; returns its id. */
  const add = useCallback(
    (type: ProviderTypeEnum): string => {
      const taken = new Set([...Object.keys(saved), ...Object.keys(drafts)]);
      let id: string = type;
      let number = 1;
      if (type === ProviderTypeEnum.CustomOpenAI) {
        // custom_openai_1, custom_openai_2, …
        while (taken.has(`${type}_${number}`)) number += 1;
        id = `${type}_${number}`;
      } else if (type === ProviderTypeEnum.AzureOpenAI) {
        // azure_openai, azure_openai_2, …
        while (taken.has(id)) {
          number += 1;
          id = `${type}_${number}`;
        }
      }
      const config = getDefaultProviderConfig(type === ProviderTypeEnum.CustomOpenAI ? id : type);
      if (type === ProviderTypeEnum.CustomOpenAI) config.name = `CustomProvider${number}`;
      if (type === ProviderTypeEnum.AzureOpenAI) config.name = `Azure OpenAI ${number}`;
      setFor(setDrafts, id, { config, apiKey: '', isNew: true });
      return id;
    },
    [saved, drafts],
  );

  const edit = useCallback(
    (id: string, changes: Partial<ProviderConfig>) => {
      setDrafts(prev => {
        const base = prev[id] ?? (saved[id] ? { config: saved[id], apiKey: '', isNew: false } : null);
        if (!base) return prev;
        return { ...prev, [id]: { ...base, config: { ...base.config, ...changes } } };
      });
      setFor(setErrors, id, null);
    },
    [saved],
  );

  const setKey = useCallback(
    (id: string, apiKey: string) => {
      setDrafts(prev => {
        const base = prev[id] ?? (saved[id] ? { config: saved[id], apiKey: '', isNew: false } : null);
        return base ? { ...prev, [id]: { ...base, apiKey } } : prev;
      });
      setFor(setErrors, id, null);
    },
    [saved],
  );

  const cancel = useCallback((id: string) => {
    setFor(setDrafts, id, null);
    setFor(setErrors, id, null);
  }, []);

  const save = useCallback(
    async (id: string): Promise<boolean> => {
      const draft = drafts[id] ?? (saved[id] ? { config: saved[id], apiKey: '', isNew: false } : null);
      if (!draft) return false;
      setFor(setBusy, id, 'saving');
      setFor(setErrors, id, null);
      try {
        const reply = await request<ProviderCheckResult>(
          {
            type: 'models_provider_save',
            providerId: id,
            config: shareable(draft.config),
            ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
          },
          CHECK_TIMEOUT_MS,
        );
        setFor(setDrafts, id, null);
        setFor(setResults, id, { health: reply.health ?? null, models: reply.models ?? 0, sample: reply.sample ?? [] });
        return true;
      } catch (error) {
        setFor(setErrors, id, errorText(error));
        return false;
      } finally {
        setFor(setBusy, id, null);
      }
    },
    [drafts, saved, request],
  );

  const removeKey = useCallback(
    async (id: string) => {
      const stored = saved[id];
      if (!stored) return;
      setFor(setBusy, id, 'saving');
      try {
        await request(
          { type: 'models_provider_save', providerId: id, config: shareable(stored), removeKey: true, check: false },
          CHECK_TIMEOUT_MS,
        );
        setFor(setResults, id, null);
      } catch (error) {
        setFor(setErrors, id, errorText(error));
      } finally {
        setFor(setBusy, id, null);
      }
    },
    [saved, request],
  );

  /** Lists the provider's models with what is being edited (or what is saved), without saving. */
  const check = useCallback(
    async (id: string) => {
      const draft = drafts[id];
      setFor(setBusy, id, 'checking');
      setFor(setErrors, id, null);
      try {
        const reply = await request<ProviderCheckResult>(
          {
            type: 'models_provider_check',
            providerId: id,
            ...(draft ? { config: shareable(draft.config) } : {}),
            ...(draft?.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
          },
          CHECK_TIMEOUT_MS,
        );
        setFor(setResults, id, { health: reply.health ?? null, models: reply.models ?? 0, sample: reply.sample ?? [] });
      } catch (error) {
        setFor(setErrors, id, errorText(error));
      } finally {
        setFor(setBusy, id, null);
      }
    },
    [drafts, request],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!saved[id]) {
        cancel(id);
        return;
      }
      setFor(setBusy, id, 'removing');
      try {
        await request({ type: 'models_provider_remove', providerId: id });
        cancel(id);
        setFor(setResults, id, null);
      } catch (error) {
        setFor(setErrors, id, errorText(error));
      } finally {
        setFor(setBusy, id, null);
      }
    },
    [saved, request, cancel],
  );

  /** Asks every provider for its models again (and looks for local servers); resolves when it has started. */
  const refresh = useCallback(async () => {
    const reply = await request<{ at: number }>({ type: 'models_refresh' });
    setRefreshing(reply.at ?? Date.now());
  }, [request]);

  /** Adds a model server found on this machine, with its defaults, and lists its models. */
  const addLocal = useCallback(
    async (kind: LocalServerKind) => {
      const type = kind === 'ollama' ? ProviderTypeEnum.Ollama : ProviderTypeEnum.LMStudio;
      const config = getDefaultProviderConfig(type);
      const found = health.local[kind]?.models ?? [];
      if (found.length) config.modelNames = found.slice(0, 20);
      setFor(setBusy, type, 'saving');
      try {
        await request({ type: 'models_provider_save', providerId: type, config: shareable(config) }, CHECK_TIMEOUT_MS);
      } catch (error) {
        setFor(setErrors, type, errorText(error));
      } finally {
        setFor(setBusy, type, null);
      }
    },
    [health.local, request],
  );

  /** The models a picker offers for a provider: the registry's list once it has one, else the saved names. */
  const modelChoices = useCallback(
    (id: string): string[] => {
      const config = drafts[id]?.config ?? saved[id];
      if (!config) return [];
      if ((config.type ?? getProviderTypeByProviderId(id)) === ProviderTypeEnum.AzureOpenAI) {
        return config.azureDeploymentNames ?? [];
      }
      const names = config.modelNames ?? llmProviderModelNames[id as keyof typeof llmProviderModelNames] ?? [];
      return chatModelChoices(id, names, catalog);
    },
    [drafts, saved, catalog],
  );

  return {
    request,
    loaded,
    rows,
    saved,
    drafts,
    catalog,
    health,
    busy,
    results,
    errors,
    refreshing: refreshing !== null,
    addableTypes,
    add,
    addLocal,
    edit,
    setKey,
    cancel,
    save,
    removeKey,
    check,
    remove,
    refresh,
    modelChoices,
    problem: (id: string) => {
      const draft = drafts[id];
      return draft ? providerProblem(draft, saved[id] ?? null) : null;
    },
  };
}

export type ProvidersState = ReturnType<typeof useProviders>;
