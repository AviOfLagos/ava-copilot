import { useEffect, useMemo, useState } from 'react';
import {
  activeModelIds,
  agentModelStore,
  DEFAULT_MODEL_SETTINGS,
  modelSettingsStore,
  pickRoleModel,
  speechToTextModelStore,
} from '@extension/storage';
import type { ModelConfig, ModelRole, ModelSettingsRecord, RoleChoice } from '@extension/storage';
import type { ProvidersState } from './useProviders';

/**
 * The model settings the Models page shows, following storage whoever changes them: roles and routing
 * (`model-settings`), the browser agent's models (`agent-models`) and dictation (`speech-to-text-model`), plus the
 * active models and what each role resolves to right now.
 */
export function useModelSettings(state: ProvidersState) {
  const [settings, setSettings] = useState<ModelSettingsRecord>(DEFAULT_MODEL_SETTINGS);
  const [agentModels, setAgentModels] = useState<Partial<Record<'planner' | 'navigator', ModelConfig>>>({});
  const [speechToText, setSpeechToText] = useState<{ provider: string; modelName: string } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void modelSettingsStore.getSettings().then(next => alive && setSettings(next));
      void agentModelStore.getAllAgentModels().then(next => alive && setAgentModels(next));
      void speechToTextModelStore.getSpeechToTextModel().then(next => alive && setSpeechToText(next ?? null));
    };
    load();
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (
        area === 'local' &&
        (changes['model-settings'] || changes['agent-models'] || changes['speech-to-text-model'])
      ) {
        load();
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  const active = useMemo(() => activeModelIds(state.saved, state.catalog), [state.saved, state.catalog]);

  /** What a role uses now; `withoutOwn` leaves out the role's own mapping, to show what Automatic means. */
  const resolve = (role: ModelRole, options: { withoutOwn?: boolean; activeOnly?: boolean } = {}) =>
    pickRoleModel({
      role,
      providers: state.saved,
      catalog: state.catalog,
      health: state.health.providers,
      settings: options.withoutOwn
        ? {
            ...settings,
            roles: Object.fromEntries(Object.entries(settings.roles).filter(([key]) => key !== role)),
            pinnedEmbed: role === 'embed' ? settings.pinnedEmbed : null,
          }
        : settings,
      agentModels,
      speechToText,
      activeOnly: options.activeOnly ?? true,
    }) as RoleChoice | null;

  return { settings, agentModels, speechToText, active, resolve };
}

export type ModelSettingsState = ReturnType<typeof useModelSettings>;
