import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

/**
 * How each provider answered the model registry's last look. Written by the background only; pages read
 * it to show health and hints. Holds no keys and no raw responses.
 */

export type ProviderHealthStatus = 'ok' | 'error' | 'unknown';

// What the user can do about a failure
export type ProviderHint =
  // Ollama refused the extension's origin: OLLAMA_ORIGINS=chrome-extension://* fixes it
  | 'ollama_origins'
  // The provider needs a key and has none
  | 'needs_key'
  // The provider refused the key
  | 'key_rejected'
  // Nothing answered at the address
  | 'unreachable';

export interface ProviderHealth {
  status: ProviderHealthStatus;
  checkedAt: number;
  // Models the provider listed
  models: number;
  // A plain sentence for the user, never a key or a response body
  error: string | null;
  errorKind: string | null;
  hint: ProviderHint | null;
}

export type LocalServerKind = 'ollama' | 'lmstudio';

/** A local model server found (or not) by the first-run look, before the user added it as a provider. */
export interface LocalServerProbe {
  kind: LocalServerKind;
  baseUrl: string;
  status: 'found' | 'refused' | 'absent';
  // Model names it offers, at most 50
  models: string[];
  checkedAt: number;
}

export interface ModelHealthRecord {
  providers: Record<string, ProviderHealth>;
  local: Partial<Record<LocalServerKind, LocalServerProbe>>;
  lastRefreshAt: number | null;
}

export const EMPTY_MODEL_HEALTH: ModelHealthRecord = { providers: {}, local: {}, lastRefreshAt: null };

export type ModelHealthStorage = BaseStorage<ModelHealthRecord> & {
  getHealth: () => Promise<ModelHealthRecord>;
  setProviders: (updates: Record<string, ProviderHealth | null>, refreshedAt?: number) => Promise<void>;
  setLocal: (probe: LocalServerProbe) => Promise<void>;
};

const storage = createStorage<ModelHealthRecord>('model-health', EMPTY_MODEL_HEALTH, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

function withDefaults(stored: Partial<ModelHealthRecord> | null | undefined): ModelHealthRecord {
  return {
    providers: stored?.providers ?? {},
    local: stored?.local ?? {},
    lastRefreshAt: stored?.lastRefreshAt ?? null,
  };
}

export const modelHealthStore: ModelHealthStorage = {
  ...storage,
  async getHealth() {
    return withDefaults(await storage.get());
  },
  /** Records the health of some providers; null forgets one (it was removed). */
  async setProviders(updates, refreshedAt) {
    const current = withDefaults(await storage.get());
    const providers = { ...current.providers };
    for (const [providerId, health] of Object.entries(updates)) {
      if (health) providers[providerId] = health;
      else delete providers[providerId];
    }
    await storage.set({ ...current, providers, lastRefreshAt: refreshedAt ?? current.lastRefreshAt });
  },
  async setLocal(probe) {
    const current = withDefaults(await storage.get());
    await storage.set({ ...current, local: { ...current.local, [probe.kind]: probe } });
  },
};
