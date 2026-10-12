/*
 * Models on the full settings page. Provider settings (keys in the vault, the model registry, checks)
 * come from the shared useProviders hook, the same one the panel's Models & usage page uses; this page
 * keeps the agent models, their reasoning effort and the speech-to-text model.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@extension/ui';
import {
  agentModelStore,
  speechToTextModelStore,
  AgentNameEnum,
  ProviderTypeEnum,
  getDefaultDisplayNameFromProviderId,
  getDefaultReasoningEffort,
  normalizeReasoningEffort,
  getProviderTypeByProviderId,
  type ReasoningEffort,
} from '@extension/storage';
import { t } from '@extension/i18n';
import { useProviders } from '../../side-panel/models/useProviders';
import { createPortRequest } from '../../side-panel/models/transport';
import { ProviderCard } from './models/ProviderCard';

// O-series, GPT-5 or GPT-6 models, the only OpenAI and Azure models that accept a reasoning effort.
// Keep in sync with isOpenAIReasoningModel in src/background/llm/providers.ts.
function isOpenAIReasoningModel(modelName: string): boolean {
  const modelNameWithoutProvider = modelName.startsWith('openai/') ? modelName.substring(7) : modelName;
  return (
    modelNameWithoutProvider.startsWith('o') ||
    (modelNameWithoutProvider.startsWith('gpt-5') && !modelNameWithoutProvider.startsWith('gpt-5-chat')) ||
    modelNameWithoutProvider.startsWith('gpt-6')
  );
}

const reasoningEffortOptions: Array<{ value: ReasoningEffort; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
];

interface ModelSettingsProps {
  isDarkMode?: boolean; // Controls dark/light theme styling
}

interface ModelOption {
  provider: string;
  providerName: string;
  model: string;
}

export const ModelSettings = ({ isDarkMode = false }: ModelSettingsProps) => {
  // The settings page has no panel port: provider commands go over a port of its own
  const request = useMemo(
    () => createPortRequest({ timeout: t('errors_timeout'), disconnected: t('models_disconnected') }),
    [],
  );
  const providers = useProviders(request);
  const [selectedModels, setSelectedModels] = useState<Record<AgentNameEnum, string>>({
    [AgentNameEnum.Navigator]: '',
    [AgentNameEnum.Planner]: '',
  });
  // Saved reasoning effort per agent; undefined uses the provider's default
  const [reasoningEffort, setReasoningEffort] = useState<Record<AgentNameEnum, ReasoningEffort | undefined>>({
    [AgentNameEnum.Navigator]: undefined,
    [AgentNameEnum.Planner]: undefined,
  });
  const [isProviderSelectorOpen, setIsProviderSelectorOpen] = useState(false);
  const newlyAddedProviderRef = useRef<string | null>(null);
  const [selectedSpeechToTextModel, setSelectedSpeechToTextModel] = useState<string>('');

  // Agent models follow storage: saving a Gemini key may assign the default models in the background
  const loadAgentModels = useCallback(async () => {
    try {
      const models: Record<AgentNameEnum, string> = { [AgentNameEnum.Planner]: '', [AgentNameEnum.Navigator]: '' };
      const efforts: Record<AgentNameEnum, ReasoningEffort | undefined> = {
        [AgentNameEnum.Planner]: undefined,
        [AgentNameEnum.Navigator]: undefined,
      };
      for (const agent of Object.values(AgentNameEnum)) {
        const config = await agentModelStore.getAgentModel(agent);
        if (config) {
          models[agent] = `${config.provider}>${config.modelName}`;
          efforts[agent] = normalizeReasoningEffort(config.reasoningEffort);
        }
      }
      setSelectedModels(models);
      setReasoningEffort(efforts);
      const speech = await speechToTextModelStore.getSpeechToTextModel();
      setSelectedSpeechToTextModel(speech ? `${speech.provider}>${speech.modelName}` : '');
    } catch (error) {
      console.error('Error loading agent models:', error);
    }
  }, []);

  useEffect(() => {
    void loadAgentModels();
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && (changes['agent-models'] || changes['speech-to-text-model'])) void loadAgentModels();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [loadAgentModels]);

  // A provider just added gets the focus: its name for custom ones, its key for the rest
  useEffect(() => {
    const providerId = newlyAddedProviderRef.current;
    if (!providerId || !providers.drafts[providerId]) return;
    const config = providers.drafts[providerId].config;
    const input = document.getElementById(
      config.type === ProviderTypeEnum.CustomOpenAI ? `${providerId}-name` : `${providerId}-api-key`,
    );
    input?.focus();
    document.getElementById(`provider-${providerId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    newlyAddedProviderRef.current = null;
  }, [providers.drafts]);

  // Close the provider menu on a click elsewhere or Escape
  useEffect(() => {
    if (!isProviderSelectorOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest('.provider-selector-container')) setIsProviderSelectorOpen(false);
    };
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setIsProviderSelectorOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isProviderSelectorOpen]);

  // The models agents can use: what the registry listed for each saved provider (or its saved names)
  const availableModels = useMemo<ModelOption[]>(
    () =>
      Object.entries(providers.saved).flatMap(([provider, config]) =>
        providers.modelChoices(provider).map(model => ({ provider, providerName: config.name || provider, model })),
      ),
    [providers],
  );

  // The provider type of a "provider>model" value; custom provider ids map to their saved type
  const getModelProviderType = (modelValue: string) => {
    const providerId = modelValue.split('>')[0];
    return providers.saved[providerId]?.type ?? getProviderTypeByProviderId(providerId);
  };

  // OpenAI and Azure reject a reasoning effort for models that don't reason; other providers get the setting
  const showsReasoningEffort = (modelValue: string | undefined): modelValue is string => {
    if (!modelValue) return false;
    const providerType = getModelProviderType(modelValue);
    if (providerType === ProviderTypeEnum.OpenAI || providerType === ProviderTypeEnum.AzureOpenAI) {
      return isOpenAIReasoningModel(modelValue.split('>')[1] ?? '');
    }
    return true;
  };

  const getEffectiveReasoningEffort = (agentName: AgentNameEnum, modelValue: string): ReasoningEffort =>
    reasoningEffort[agentName] ?? getDefaultReasoningEffort(getModelProviderType(modelValue));

  const handleModelChange = async (agentName: AgentNameEnum, modelValue: string) => {
    const [provider, model] = modelValue.split('>');
    // Keep the reasoning effort when switching between models of the same provider type, otherwise use the default
    const previousModel = selectedModels[agentName];
    const keepsEffort =
      !!previousModel && !!model && getModelProviderType(previousModel) === getModelProviderType(modelValue);
    const newReasoningEffort = keepsEffort ? reasoningEffort[agentName] : undefined;
    setReasoningEffort(prev => ({ ...prev, [agentName]: newReasoningEffort }));
    setSelectedModels(prev => ({ ...prev, [agentName]: modelValue }));

    try {
      if (model) {
        await agentModelStore.setAgentModel(agentName, {
          provider,
          modelName: model,
          reasoningEffort: showsReasoningEffort(modelValue)
            ? (newReasoningEffort ?? getDefaultReasoningEffort(getModelProviderType(modelValue)))
            : undefined,
        });
      } else {
        await agentModelStore.resetAgentModel(agentName);
      }
    } catch (error) {
      console.error('Error saving agent model:', error);
    }
  };

  const handleReasoningEffortChange = async (agentName: AgentNameEnum, value: ReasoningEffort) => {
    setReasoningEffort(prev => ({ ...prev, [agentName]: value }));
    if (showsReasoningEffort(selectedModels[agentName])) {
      try {
        const [provider, modelName] = selectedModels[agentName].split('>');
        if (provider && modelName) {
          await agentModelStore.setAgentModel(agentName, { provider, modelName, reasoningEffort: value });
        }
      } catch (error) {
        console.error('Error saving reasoning effort:', error);
      }
    }
  };

  const handleSpeechToTextModelChange = async (modelValue: string) => {
    setSelectedSpeechToTextModel(modelValue);
    try {
      if (modelValue) {
        const [provider, modelName] = modelValue.split('>');
        await speechToTextModelStore.setSpeechToTextModel({ provider, modelName });
      } else {
        await speechToTextModelStore.resetSpeechToTextModel();
      }
    } catch (error) {
      console.error('Error saving speech-to-text model:', error);
    }
  };

  const getAgentDescription = (agentName: AgentNameEnum) => {
    switch (agentName) {
      case AgentNameEnum.Navigator:
        return t('options_models_agents_navigator');
      case AgentNameEnum.Planner:
        return t('options_models_agents_planner');
      default:
        return '';
    }
  };

  /** The options of a model select, keeping the current choice even when no provider lists it any more. */
  const modelOptions = (current: string, models: ModelOption[]) => {
    const values = new Set(models.map(({ provider, model }) => `${provider}>${model}`));
    return (
      <>
        {current && !values.has(current) && <option value={current}>{current.replace('>', ' > ')}</option>}
        {models.map(({ provider, providerName, model }) => (
          <option key={`${provider}>${model}`} value={`${provider}>${model}`}>
            {`${providerName} > ${model}`}
          </option>
        ))}
      </>
    );
  };

  const renderModelSelect = (agentName: AgentNameEnum) => (
    <div
      className={`rounded-lg border ${isDarkMode ? 'border-gray-700 bg-slate-800' : 'border-gray-200 bg-gray-50'} p-4`}>
      <h3 className={`mb-2 text-lg font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
        {agentName.charAt(0).toUpperCase() + agentName.slice(1)}
      </h3>
      <p className={`mb-4 text-sm font-normal ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
        {getAgentDescription(agentName)}
      </p>

      <div className="space-y-4">
        <div className="flex items-center">
          <label
            htmlFor={`${agentName}-model`}
            className={`w-24 text-sm font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
            {t('options_models_labels_model')}
          </label>
          <select
            id={`${agentName}-model`}
            className={`flex-1 rounded-md border text-sm ${isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-200' : 'border-gray-300 bg-white text-gray-700'} px-3 py-2`}
            disabled={availableModels.length === 0}
            value={selectedModels[agentName] || ''}
            onChange={e => handleModelChange(agentName, e.target.value)}>
            <option key="default" value="">
              {t('options_models_chooseModel')}
            </option>
            {modelOptions(selectedModels[agentName], availableModels)}
          </select>
        </div>

        {/* Reasoning effort; None sends no effort */}
        {showsReasoningEffort(selectedModels[agentName]) && (
          <div className="flex items-center">
            <label
              htmlFor={`${agentName}-reasoning-effort`}
              className={`w-24 text-sm font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              {t('options_models_labels_reasoning')}
            </label>
            <div className="flex flex-1 items-center space-x-2">
              <select
                id={`${agentName}-reasoning-effort`}
                value={getEffectiveReasoningEffort(agentName, selectedModels[agentName])}
                onChange={e => handleReasoningEffortChange(agentName, e.target.value as ReasoningEffort)}
                className={`flex-1 rounded-md border text-sm ${isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-200' : 'border-gray-300 bg-white text-gray-700'} px-3 py-2`}>
                {reasoningEffortOptions.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const addProvider = (type: ProviderTypeEnum) => {
    setIsProviderSelectorOpen(false);
    newlyAddedProviderRef.current = providers.add(type);
  };

  return (
    <section className="space-y-6">
      {/* Providers */}
      <div
        className={`rounded-lg border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-gray-50'} p-6 text-left shadow-sm`}>
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className={`text-xl font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
            {t('options_models_providers_header')}
          </h2>
          <Button variant="secondary" disabled={providers.refreshing} onClick={() => void providers.refresh()}>
            {providers.refreshing ? t('models_catalog_refreshing') : t('models_catalog_refresh')}
          </Button>
        </div>
        <p className={`mb-4 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t('models_key_vault')}</p>
        <div className="space-y-6">
          {providers.rows.length === 0 ? (
            <div className="py-8 text-center text-gray-500">
              <p className="mb-4">{t('options_models_providers_notConfigured')}</p>
            </div>
          ) : (
            providers.rows.map((row, index) => (
              <div key={row.id}>
                <ProviderCard row={row} state={providers} isDarkMode={isDarkMode} />
                {index < providers.rows.length - 1 && (
                  <div className={`mt-4 border-t ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`} />
                )}
              </div>
            ))
          )}

          {/* Add Provider button and menu */}
          <div className="provider-selector-container relative pt-4">
            <Button
              variant="secondary"
              aria-expanded={isProviderSelectorOpen}
              data-provider-menu-trigger
              onClick={() => setIsProviderSelectorOpen(prev => !prev)}
              className={`flex w-full items-center justify-center font-medium ${
                isDarkMode
                  ? 'border-blue-700 bg-blue-600 text-white hover:bg-blue-500'
                  : 'border-blue-200 bg-blue-100 text-blue-800 hover:bg-blue-200'
              }`}>
              <span className="mr-2 text-sm">+</span>{' '}
              <span className="text-sm">{t('options_models_addNewProvider')}</span>
            </Button>

            {isProviderSelectorOpen && (
              <div
                data-provider-menu
                className={`absolute z-10 mt-2 w-full overflow-hidden rounded-md border ${
                  isDarkMode
                    ? 'border-blue-600 bg-slate-700 shadow-lg shadow-slate-900/50'
                    : 'border-blue-200 bg-white shadow-xl shadow-blue-100/50'
                }`}>
                <div className="py-1">
                  {providers.addableTypes.map(type => (
                    <button
                      key={type}
                      type="button"
                      data-provider-type={type}
                      className={`flex w-full items-center px-4 py-3 text-left text-sm ${
                        isDarkMode
                          ? 'text-blue-200 hover:bg-blue-600/30 hover:text-white'
                          : 'text-blue-700 hover:bg-blue-100 hover:text-blue-800'
                      } transition-colors duration-150`}
                      onClick={() => addProvider(type)}>
                      <span className="font-medium">
                        {type === ProviderTypeEnum.CustomOpenAI
                          ? t('options_models_providers_openaiCompatible')
                          : getDefaultDisplayNameFromProviderId(type)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Agent models */}
      <div
        className={`rounded-lg border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-gray-50'} p-6 text-left shadow-sm`}>
        <h2 className={`mb-4 text-left text-xl font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
          {t('options_models_selection_header')}
        </h2>
        <div className="space-y-4">
          {[AgentNameEnum.Planner, AgentNameEnum.Navigator].map(agentName => (
            <div key={agentName}>{renderModelSelect(agentName)}</div>
          ))}
        </div>
      </div>

      {/* Speech-to-text model */}
      <div
        className={`rounded-lg border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-gray-50'} p-6 text-left shadow-sm`}>
        <h2 className={`mb-4 text-left text-xl font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
          {t('options_models_speechToText_header')}
        </h2>
        <p className={`mb-4 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          {t('options_models_stt_desc')}
        </p>

        <div
          className={`rounded-lg border ${isDarkMode ? 'border-gray-700 bg-slate-800' : 'border-gray-200 bg-gray-50'} p-4`}>
          <div className="flex items-center">
            <label
              htmlFor="speech-to-text-model"
              className={`w-24 text-sm font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              {t('options_models_labels_model')}
            </label>
            <select
              id="speech-to-text-model"
              className={`flex-1 rounded-md border text-sm ${isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-200' : 'border-gray-300 bg-white text-gray-700'} px-3 py-2`}
              value={selectedSpeechToTextModel}
              onChange={e => handleSpeechToTextModelChange(e.target.value)}>
              <option value="">{t('options_models_chooseModel')}</option>
              {/* Only Gemini models take the audio */}
              {modelOptions(
                selectedSpeechToTextModel,
                availableModels.filter(
                  ({ provider }) =>
                    (providers.saved[provider]?.type ?? getProviderTypeByProviderId(provider)) ===
                    ProviderTypeEnum.Gemini,
                ),
              )}
            </select>
          </div>
        </div>
      </div>
    </section>
  );
};
