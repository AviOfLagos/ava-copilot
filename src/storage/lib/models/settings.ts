import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';
import type { ModelRole } from './types';

/** A model chosen for a role: the provider's id in the provider settings, and the model's name there. */
export interface RoleTarget {
  providerId: string;
  model: string;
}

export type RoleMap = Partial<Record<ModelRole, RoleTarget>>;

export interface ModelSettingsRecord {
  // The user's choice per role; a role left out is picked from what is available
  roles: RoleMap;
  // Choices that win over `roles` inside one workspace, or for one agent (an agent's wins over its workspace's)
  workspaceRoles: Record<string, RoleMap>;
  agentRoles: Record<string, RoleMap>;
  // The embedding model, fixed the first time one is picked: another model would mean embedding everything again
  pinnedEmbed: RoleTarget | null;
  // Tokens a day on models with no known price; 0 means no cap. Models with a price count against the cost cap
  unpricedDailyTokenCap: number;
  // The first look for local servers (Ollama, LM Studio) has run
  localProbeDone: boolean;
}

export const DEFAULT_MODEL_SETTINGS: ModelSettingsRecord = {
  roles: {},
  workspaceRoles: {},
  agentRoles: {},
  pinnedEmbed: null,
  unpricedDailyTokenCap: 2_000_000,
  localProbeDone: false,
};

export const MODEL_ROLES: ModelRole[] = [
  'fast',
  'smart',
  'vision',
  'local',
  'embed',
  'transcribe',
  'realtime',
  'tts',
  'search',
];

export type ModelSettingsStorage = BaseStorage<ModelSettingsRecord> & {
  getSettings: () => Promise<ModelSettingsRecord>;
  updateSettings: (changes: Partial<ModelSettingsRecord>) => Promise<void>;
  /** Sets or clears (null) the model for a role, for everyone, one workspace or one agent. */
  setRole: (
    role: ModelRole,
    target: RoleTarget | null,
    scope?: { workspaceId?: string; agentId?: string },
  ) => Promise<void>;
};

const storage = createStorage<ModelSettingsRecord>('model-settings', DEFAULT_MODEL_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

function withDefaults(stored: Partial<ModelSettingsRecord> | null | undefined): ModelSettingsRecord {
  return { ...DEFAULT_MODEL_SETTINGS, ...(stored ?? {}) };
}

function updateMap(map: RoleMap | undefined, role: ModelRole, target: RoleTarget | null): RoleMap {
  const next = { ...(map ?? {}) };
  if (target) next[role] = { providerId: target.providerId, model: target.model };
  else delete next[role];
  return next;
}

export const modelSettingsStore: ModelSettingsStorage = {
  ...storage,
  async getSettings() {
    return withDefaults(await storage.get());
  },
  async updateSettings(changes) {
    const current = withDefaults(await storage.get());
    await storage.set({ ...current, ...changes });
  },
  async setRole(role, target, scope = {}) {
    const current = withDefaults(await storage.get());
    if (scope.agentId) {
      const agentRoles = {
        ...current.agentRoles,
        [scope.agentId]: updateMap(current.agentRoles[scope.agentId], role, target),
      };
      await storage.set({ ...current, agentRoles });
    } else if (scope.workspaceId) {
      const workspaceRoles = {
        ...current.workspaceRoles,
        [scope.workspaceId]: updateMap(current.workspaceRoles[scope.workspaceId], role, target),
      };
      await storage.set({ ...current, workspaceRoles });
    } else {
      // Choosing an embedding model by hand is the one way to change the pinned one
      const pinnedEmbed = role === 'embed' ? target : current.pinnedEmbed;
      await storage.set({ ...current, roles: updateMap(current.roles, role, target), pinnedEmbed });
    }
  },
};
