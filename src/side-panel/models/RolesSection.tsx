import { useEffect, useMemo, useState } from 'react';
import { t } from '@extension/i18n';
import {
  agentModelStore,
  DEFAULT_MODEL_SETTINGS,
  fitsRole,
  getDefaultDisplayNameFromProviderId,
  MODEL_ROLES,
  modelSettingsStore,
  pickRoleModel,
  providerIsUsable,
  savedModelEntries,
  speechToTextModelStore,
} from '@extension/storage';
import type { ModelConfig, ModelRole, ModelSettingsRecord } from '@extension/storage';
import { inputClass, Section } from './ui';
import type { ProvidersState } from './useProviders';

type MessageKey = Parameters<typeof t>[0];

const ROLE_LABELS: Record<ModelRole, { name: MessageKey; hint: MessageKey }> = {
  fast: { name: 'models_role_fast', hint: 'models_role_fast_hint' },
  smart: { name: 'models_role_smart', hint: 'models_role_smart_hint' },
  vision: { name: 'models_role_vision', hint: 'models_role_vision_hint' },
  local: { name: 'models_role_local', hint: 'models_role_local_hint' },
  embed: { name: 'models_role_embed', hint: 'models_role_embed_hint' },
  transcribe: { name: 'models_role_transcribe', hint: 'models_role_transcribe_hint' },
  realtime: { name: 'models_role_realtime', hint: 'models_role_realtime_hint' },
  tts: { name: 'models_role_tts', hint: 'models_role_tts_hint' },
  search: { name: 'models_role_search', hint: 'models_role_search_hint' },
};

// Provider ids never hold it, so the first one splits a value into provider and model
const SEPARATOR = '|';

/** Which model each kind of work uses: Automatic, or one the user picks. */
export default function RolesSection({ state }: { state: ProvidersState }) {
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

  const usableProviders = useMemo(
    () => Object.fromEntries(Object.entries(state.saved).filter(([id, config]) => providerIsUsable(config, id))),
    [state.saved],
  );
  const candidates = useMemo(
    () => [
      ...state.catalog.filter(entry => entry.providerId in usableProviders),
      ...savedModelEntries(usableProviders, state.catalog),
    ],
    [state.catalog, usableProviders],
  );

  const providerName = (id: string) => state.saved[id]?.name || getDefaultDisplayNameFromProviderId(id);

  return (
    <Section label={t('models_roles')}>
      <p className="text-muted-foreground px-3 py-2 text-[11.5px]">{t('models_roles_hint')}</p>
      {MODEL_ROLES.map(role => {
        const chosen = settings.roles[role];
        // What Automatic means now: the choice without this role's own mapping
        const automatic = pickRoleModel({
          role,
          providers: state.saved,
          catalog: state.catalog,
          health: state.health.providers,
          settings: {
            ...settings,
            roles: Object.fromEntries(Object.entries(settings.roles).filter(([key]) => key !== role)),
            pinnedEmbed: role === 'embed' ? settings.pinnedEmbed : null,
          },
          agentModels,
          speechToText,
        });
        const fitting = candidates.filter(entry => fitsRole(entry, role));
        const byProvider = new Map<string, string[]>();
        for (const entry of fitting) {
          byProvider.set(entry.providerId, [...(byProvider.get(entry.providerId) ?? []), entry.model]);
        }
        // A chosen model the catalog no longer lists stays visible
        if (chosen && !fitting.some(entry => entry.providerId === chosen.providerId && entry.model === chosen.model)) {
          byProvider.set(chosen.providerId, [...(byProvider.get(chosen.providerId) ?? []), chosen.model]);
        }
        const value = chosen ? `${chosen.providerId}${SEPARATOR}${chosen.model}` : '';
        const selectId = `models-role-${role}`;
        const active = chosen ? null : automatic;
        return (
          <div key={role} className="px-3 py-2.5" data-role={role}>
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor={selectId} className="text-[13px]">
                {t(ROLE_LABELS[role].name)}
              </label>
              {active?.standIn && <span className="text-destructive text-[11px]">{t('models_role_standIn')}</span>}
            </div>
            <p className="text-muted-foreground mb-1 text-[11.5px]">{t(ROLE_LABELS[role].hint)}</p>
            <select
              id={selectId}
              value={value}
              onChange={event => {
                const at = event.target.value.indexOf(SEPARATOR);
                const providerId = event.target.value.slice(0, at);
                const model = event.target.value.slice(at + 1);
                void modelSettingsStore.setRole(role, at > 0 ? { providerId, model } : null);
              }}
              className={inputClass}>
              <option value="">
                {automatic
                  ? t('models_role_auto', [`${providerName(automatic.providerId)} · ${automatic.model}`])
                  : t('models_role_autoNone')}
              </option>
              {[...byProvider].map(([providerId, models]) => (
                <optgroup key={providerId} label={providerName(providerId)}>
                  {[...new Set(models)].sort().map(model => (
                    <option key={model} value={`${providerId}${SEPARATOR}${model}`}>
                      {model}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {role === 'embed' && (settings.pinnedEmbed || chosen) && (
              <p className="text-muted-foreground mt-1 text-[11px]">{t('models_role_pinned')}</p>
            )}
          </div>
        );
      })}
    </Section>
  );
}
