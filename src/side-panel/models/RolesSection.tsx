import { useMemo, useState } from 'react';
import { t } from '@extension/i18n';
import {
  agentModelStore,
  AgentNameEnum,
  fitsRole,
  getDefaultDisplayNameFromProviderId,
  getProviderTypeByProviderId,
  llmProviderStore,
  MODEL_ROLES,
  modelSettingsStore,
  normalizeReasoningEffort,
  ProviderTypeEnum,
  providerIsUsable,
  savedModelEntries,
  savedNames,
  speechToTextModelStore,
  withModelActive,
} from '@extension/storage';
import type { ModelRole, ReasoningEffort, RoleTarget } from '@extension/storage';
import { Button } from '../components/ui/button';
import { ROLE_LABELS } from './roleLabels';
import { inputClass, Section } from './ui';
import type { ModelSettingsState } from './useModelSettings';
import type { ProvidersState } from './useProviders';

type MessageKey = Parameters<typeof t>[0];

// Provider ids never hold it, so the first one splits a value into provider and model
const SEPARATOR = '|';

// The browser agent's models are the smart and fast roles: one choice, two places it is used
const AGENT_FOR: Partial<Record<ModelRole, AgentNameEnum>> = {
  smart: AgentNameEnum.Planner,
  fast: AgentNameEnum.Navigator,
};

// What to do when no active model can do the work
const EMPTY_HINT: Partial<Record<ModelRole, MessageKey>> = {
  local: 'models_role_empty_local',
  embed: 'models_role_empty_embed',
  realtime: 'models_role_empty_gemini',
  tts: 'models_role_empty_gemini',
  transcribe: 'models_role_empty_gemini',
  search: 'models_role_empty_gemini',
};

// O-series, GPT-5 or GPT-6: the only OpenAI and Azure models that take a reasoning effort.
// Keep in sync with isOpenAIReasoningModel in src/background/llm/providers.ts.
function takesReasoningEffort(model: string): boolean {
  const name = model.startsWith('openai/') ? model.slice(7) : model;
  return (
    name.startsWith('o') || (name.startsWith('gpt-5') && !name.startsWith('gpt-5-chat')) || name.startsWith('gpt-6')
  );
}

const EFFORTS: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh'];

/** Which model each kind of work uses, picked from the active models only: Automatic, or one the user picks. */
export default function RolesSection({ state, models }: { state: ProvidersState; models: ModelSettingsState }) {
  const [error, setError] = useState('');
  const { settings, agentModels } = models;

  const candidates = useMemo(() => {
    const usable = Object.fromEntries(
      Object.entries(state.saved).filter(([id, config]) => providerIsUsable(config, id)),
    );
    return [
      ...state.catalog.filter(entry => entry.providerId in usable),
      ...savedModelEntries(usable, state.catalog),
    ].filter(entry => models.active.has(entry.id));
  }, [state.catalog, state.saved, models.active]);

  const providerName = (id: string) => state.saved[id]?.name || getDefaultDisplayNameFromProviderId(id);
  const typeOf = (id: string) => state.saved[id]?.type ?? getProviderTypeByProviderId(id);

  const choose = async (role: ModelRole, target: RoleTarget | null) => {
    setError('');
    try {
      await modelSettingsStore.setRole(role, target);
      const agent = AGENT_FOR[role];
      if (agent && target) {
        const current = agentModels[agent];
        await agentModelStore.setAgentModel(agent, {
          provider: target.providerId,
          modelName: target.model,
          ...(current?.reasoningEffort && takesReasoningEffort(target.model)
            ? { reasoningEffort: current.reasoningEffort }
            : {}),
        });
      }
      // Dictation in the chat box works with a Gemini key only
      if (role === 'transcribe' && target && typeOf(target.providerId) === ProviderTypeEnum.Gemini) {
        await speechToTextModelStore.setSpeechToTextModel({ provider: target.providerId, modelName: target.model });
      }
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    }
  };

  /** Turns a model on, for the empty state's one-click suggestion. */
  const turnOn = async (target: RoleTarget) => {
    const config = state.saved[target.providerId];
    if (!config) return;
    const listed = state.catalog.filter(entry => entry.providerId === target.providerId).map(entry => entry.model);
    const next = withModelActive(savedNames(target.providerId, config), listed, target.model, true);
    if (next) await llmProviderStore.setModelNames(target.providerId, next);
  };

  return (
    <Section label={t('models_roles')}>
      <p className="text-muted-foreground px-3 py-2 text-[11.5px]">{t('models_roles_hint')}</p>
      {error && (
        <p role="alert" className="text-destructive px-3 py-1 text-[11.5px]">
          {error}
        </p>
      )}
      {MODEL_ROLES.map(role => {
        const agent = AGENT_FOR[role];
        const agentModel = agent ? agentModels[agent] : undefined;
        const chosen = settings.roles[role] ?? null;
        const automatic = models.resolve(role, { withoutOwn: true });
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
        const current = chosen ?? automatic;
        // Nothing active can do it: say what would, and offer the best inactive one
        const suggestion = fitting.length === 0 ? models.resolve(role, { activeOnly: false }) : null;
        return (
          <div key={role} className="px-3 py-2.5" data-role={role}>
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor={selectId} className="text-[13px]">
                {t(ROLE_LABELS[role].name)}
              </label>
              {!chosen && automatic?.standIn && (
                <span className="text-destructive text-[11px]">{t('models_role_standIn')}</span>
              )}
            </div>
            <p className="text-muted-foreground mb-1 text-[11.5px]">
              {t(ROLE_LABELS[role].hint)}
              {agent && ` ${t(agent === AgentNameEnum.Planner ? 'models_role_planner' : 'models_role_navigator')}`}
            </p>
            {fitting.length === 0 && !chosen ? (
              <div className="bg-muted/40 rounded-lg px-2 py-1.5" data-role-empty={role}>
                <p className="text-[11.5px]">{t(EMPTY_HINT[role] ?? 'models_role_empty')}</p>
                {suggestion && (
                  <Button
                    size="sm"
                    variant="glass"
                    className="mt-1"
                    onClick={() => void turnOn({ providerId: suggestion.providerId, model: suggestion.model })}>
                    {t('models_role_turnOn', [suggestion.model])}
                  </Button>
                )}
              </div>
            ) : (
              <select
                id={selectId}
                value={value}
                onChange={event => {
                  const at = event.target.value.indexOf(SEPARATOR);
                  void choose(
                    role,
                    at > 0
                      ? { providerId: event.target.value.slice(0, at), model: event.target.value.slice(at + 1) }
                      : null,
                  );
                }}
                className={inputClass}>
                <option value="">
                  {automatic
                    ? t('models_role_auto', [`${providerName(automatic.providerId)} · ${automatic.model}`])
                    : t('models_role_autoNone')}
                </option>
                {[...byProvider].map(([providerId, names]) => (
                  <optgroup key={providerId} label={providerName(providerId)}>
                    {[...new Set(names)].sort().map(model => (
                      <option key={model} value={`${providerId}${SEPARATOR}${model}`}>
                        {model}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
            {agent && agentModel && current && takesReasoningEffort(current.model) && (
              <div className="mt-1.5 flex items-center gap-2">
                <label htmlFor={`${selectId}-effort`} className="text-muted-foreground text-[11.5px]">
                  {t('models_role_effort')}
                </label>
                <select
                  id={`${selectId}-effort`}
                  value={normalizeReasoningEffort(agentModel.reasoningEffort) ?? ''}
                  onChange={event =>
                    void agentModelStore.setAgentModel(agent, {
                      ...agentModel,
                      reasoningEffort: (event.target.value || undefined) as ReasoningEffort | undefined,
                    })
                  }
                  className={`${inputClass} w-auto`}>
                  <option value="">{t('models_role_effortDefault')}</option>
                  {EFFORTS.map(effort => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {role === 'transcribe' && current && typeOf(current.providerId) !== ProviderTypeEnum.Gemini && (
              <p className="text-muted-foreground mt-1 text-[11px]">{t('models_role_dictationGemini')}</p>
            )}
            {role === 'embed' && (settings.pinnedEmbed || chosen) && (
              <p className="text-muted-foreground mt-1 text-[11px]">{t('models_role_pinned')}</p>
            )}
          </div>
        );
      })}
    </Section>
  );
}
