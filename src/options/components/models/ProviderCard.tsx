import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Button } from '@extension/ui';
import { isKeyOptional, llmProviderModelNames, ProviderTypeEnum, takesBaseUrl } from '@extension/storage';
import type { ProviderHint } from '@extension/storage';
import { t } from '@extension/i18n';
import type { ProviderRow, ProvidersState } from '../../../side-panel/models/useProviders';

type MessageKey = Parameters<typeof t>[0];

const HINTS: Record<ProviderHint, MessageKey> = {
  ollama_origins: 'models_hint_ollama_origins',
  needs_key: 'models_hint_needs_key',
  key_rejected: 'models_hint_key_rejected',
  unreachable: 'models_hint_unreachable',
};

const field = (isDarkMode: boolean) =>
  `rounded-md border text-sm ${
    isDarkMode
      ? 'border-slate-600 bg-slate-700 text-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-800'
      : 'border-gray-300 bg-white text-gray-700 focus:border-blue-400 focus:ring-2 focus:ring-blue-200'
  } p-2 outline-none`;

const labelClass = (isDarkMode: boolean) =>
  `w-24 shrink-0 text-sm font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`;

function Chips({
  values,
  onRemove,
  isDarkMode,
}: {
  values: string[];
  onRemove: (value: string) => void;
  isDarkMode: boolean;
}) {
  return (
    <>
      {values.map(value => (
        <div
          key={value}
          className={`flex items-center rounded-full ${isDarkMode ? 'bg-blue-900 text-blue-100' : 'bg-blue-100 text-blue-800'} px-2 py-1 text-sm`}>
          <span>{value}</span>
          <button
            type="button"
            onClick={() => onRemove(value)}
            className={`ml-1 font-bold ${isDarkMode ? 'text-blue-300 hover:text-blue-100' : 'text-blue-600 hover:text-blue-800'}`}
            aria-label={t('models_chip_remove', [value])}>
            ×
          </button>
        </div>
      ))}
    </>
  );
}

/** What the last save or check said, as a sentence with the fix when there is one. */
function status(row: ProviderRow, state: ProvidersState): { text: string; alert: boolean } | null {
  const busy = state.busy[row.id];
  if (busy) {
    return {
      text: t(busy === 'saving' ? 'models_saving' : busy === 'checking' ? 'models_checking' : 'models_removing'),
      alert: false,
    };
  }
  if (state.errors[row.id]) return { text: state.errors[row.id], alert: true };
  const health = state.results[row.id]?.health ?? row.health;
  if (!health) return null;
  if (health.hint) return { text: t(HINTS[health.hint]), alert: health.status === 'error' };
  if (health.status === 'error') return { text: t('models_error_generic'), alert: true };
  if (health.status === 'unknown' && health.errorKind) return { text: t('models_result_unknown'), alert: false };
  if (health.status === 'ok') {
    return { text: t('models_result_ok', [String(state.results[row.id]?.models ?? row.modelCount)]), alert: false };
  }
  return null;
}

/**
 * One provider on the settings page. Fields edit a draft; Save sends it to the background, which keeps the
 * key in the vault and lists the provider's models. A saved key is shown as ••••last4 and never filled in.
 */
export function ProviderCard({
  row,
  state,
  isDarkMode,
}: {
  row: ProviderRow;
  state: ProvidersState;
  isDarkMode: boolean;
}) {
  const [showKey, setShowKey] = useState(false);
  const [newModel, setNewModel] = useState('');
  const { id, config, type } = row;
  const editing = Boolean(row.draft);
  const isNew = Boolean(row.draft?.isNew);
  const problem = state.problem(id);
  const line = status(row, state);
  const typedKey = row.draft?.apiKey ?? '';
  const models =
    config.modelNames !== undefined
      ? config.modelNames
      : llmProviderModelNames[id as keyof typeof llmProviderModelNames] || [];
  const listed = state.modelChoices(id).filter(model => !models.includes(model));

  const addModel = (value: string) => {
    const name = value.trim();
    if (!name) return;
    if (type === ProviderTypeEnum.AzureOpenAI) {
      const deployments = config.azureDeploymentNames ?? [];
      if (!deployments.includes(name)) state.edit(id, { azureDeploymentNames: [...deployments, name] });
    } else if (!models.includes(name)) {
      state.edit(id, { modelNames: [...models, name] });
    }
    setNewModel('');
  };
  const onModelKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      addModel(newModel);
    }
  };

  const keyPlaceholder = row.hasKey
    ? t('models_key_keepPlaceholder')
    : type === ProviderTypeEnum.Ollama
      ? t('options_models_providers_apiKey_placeholder_ollama')
      : isKeyOptional(type)
        ? t('options_models_providers_apiKey_placeholder_optional')
        : t('options_models_providers_apiKey_placeholder_required');

  return (
    <div
      id={`provider-${id}`}
      data-provider={id}
      className={`space-y-4 ${isNew ? `rounded-lg border p-4 ${isDarkMode ? 'border-blue-700 bg-slate-700' : 'border-blue-200 bg-blue-50/70'}` : ''}`}>
      <div className="flex items-center justify-between">
        <h3 className={`text-lg font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
          {config.name || id}
          {row.local && (
            <span className="ml-2 rounded-full border px-2 py-0.5 align-middle font-mono text-xs">
              {t('models_provider_local')}
            </span>
          )}
        </h3>
        <div className="flex space-x-2">
          {editing && (
            <Button variant="secondary" onClick={() => state.cancel(id)}>
              {t('options_models_providers_btnCancel')}
            </Button>
          )}
          {editing ? (
            <>
              <Button
                variant="secondary"
                disabled={!!state.busy[id] || (!!problem && problem !== 'models_problem_key')}
                onClick={() => void state.check(id)}>
                {t('models_test')}
              </Button>
              <Button variant="primary" disabled={!!problem || !!state.busy[id]} onClick={() => void state.save(id)}>
                {t('options_models_providers_btnSave')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" disabled={!!state.busy[id]} onClick={() => void state.check(id)}>
                {t('models_test')}
              </Button>
              <Button variant="danger" disabled={!!state.busy[id]} onClick={() => void state.remove(id)}>
                {t('options_models_providers_btnDelete')}
              </Button>
            </>
          )}
        </div>
      </div>

      {isNew && (
        <div className={`mb-2 text-sm ${isDarkMode ? 'text-teal-300' : 'text-teal-700'}`}>
          <p>{t('options_models_providers_setupInstructions')}</p>
        </div>
      )}

      <div className="space-y-3">
        {type === ProviderTypeEnum.CustomOpenAI && (
          <div className="flex flex-col">
            <div className="flex items-center">
              <label htmlFor={`${id}-name`} className={labelClass(isDarkMode)}>
                {t('options_models_providers_custom_name')}
              </label>
              <input
                id={`${id}-name`}
                type="text"
                placeholder={t('options_models_providers_custom_name_placeholder')}
                value={config.name || ''}
                onChange={event => state.edit(id, { name: event.target.value })}
                className={`flex-1 ${field(isDarkMode)}`}
              />
            </div>
            <p className={`ml-24 mt-1 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('options_models_providers_custom_name_desc')}
            </p>
          </div>
        )}

        <div className="flex items-center">
          <label htmlFor={`${id}-api-key`} className={labelClass(isDarkMode)}>
            {t('options_models_providers_apiKey')}
            {isKeyOptional(type) ? '' : '*'}
          </label>
          <div className="relative flex flex-1 items-center gap-2">
            {row.hasKey && (
              <span className="shrink-0 font-mono text-sm" data-key-display>
                {row.keyDisplay}
              </span>
            )}
            <input
              id={`${id}-api-key`}
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder={keyPlaceholder}
              value={typedKey}
              onChange={event => state.setKey(id, event.target.value)}
              className={`w-full ${field(isDarkMode)}`}
            />
            {typedKey && (
              <button
                type="button"
                className={isDarkMode ? 'text-gray-400 hover:text-gray-300' : 'text-gray-500 hover:text-gray-700'}
                onClick={() => setShowKey(!showKey)}
                aria-label={
                  showKey ? t('options_models_providers_apiKey_hide') : t('options_models_providers_apiKey_show')
                }>
                {showKey ? t('models_key_hide') : t('models_key_show')}
              </button>
            )}
            {row.hasKey && row.keyOptional && !editing && (
              <button
                type="button"
                className={`shrink-0 text-sm ${isDarkMode ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-800'}`}
                onClick={() => void state.removeKey(id)}>
                {t('models_key_remove')}
              </button>
            )}
          </div>
        </div>

        {takesBaseUrl(type) && (
          <div className="flex items-center">
            <label htmlFor={`${id}-base-url`} className={labelClass(isDarkMode)}>
              {type === ProviderTypeEnum.AzureOpenAI
                ? t('options_models_providers_endpoint')
                : t('options_models_providers_baseUrl')}
              *
            </label>
            <input
              id={`${id}-base-url`}
              type="text"
              placeholder={
                type === ProviderTypeEnum.AzureOpenAI
                  ? t('options_models_providers_placeholders_baseUrl_azure')
                  : type === ProviderTypeEnum.OpenRouter
                    ? t('options_models_providers_placeholders_baseUrl_openrouter')
                    : type === ProviderTypeEnum.Ollama
                      ? t('options_models_providers_placeholders_baseUrl_ollama')
                      : t('options_models_providers_placeholders_baseUrl_custom')
              }
              value={config.baseUrl || ''}
              onChange={event => state.edit(id, { baseUrl: event.target.value })}
              className={`flex-1 ${field(isDarkMode)}`}
            />
          </div>
        )}

        {type === ProviderTypeEnum.AzureOpenAI && (
          <>
            <div className="flex items-start">
              <label htmlFor={`${id}-azure-deployment-input`} className={`pt-2 ${labelClass(isDarkMode)}`}>
                {t('options_models_providers_deployment')}*
              </label>
              <div className="flex-1 space-y-2">
                <div
                  className={`flex min-h-[42px] flex-wrap items-center gap-2 rounded-md border ${isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-200' : 'border-gray-300 bg-white text-gray-700'} p-2`}>
                  <Chips
                    values={config.azureDeploymentNames ?? []}
                    isDarkMode={isDarkMode}
                    onRemove={value =>
                      state.edit(id, {
                        azureDeploymentNames: (config.azureDeploymentNames ?? []).filter(name => name !== value),
                      })
                    }
                  />
                  <input
                    id={`${id}-azure-deployment-input`}
                    type="text"
                    placeholder={t('options_models_providers_placeholders_azureDeployment')}
                    value={newModel}
                    onChange={event => setNewModel(event.target.value)}
                    onKeyDown={onModelKey}
                    className={`min-w-[150px] flex-1 border-none bg-transparent p-1 text-sm outline-none ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`}
                  />
                </div>
                <p className={`mt-1 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  {t('options_models_providers_deployment_desc')}
                </p>
              </div>
            </div>
            <div className="flex items-center">
              <label htmlFor={`${id}-azure-version`} className={labelClass(isDarkMode)}>
                {t('options_models_providers_apiVersion')}*
              </label>
              <input
                id={`${id}-azure-version`}
                type="text"
                placeholder={t('options_models_providers_placeholders_azureApiVersion')}
                value={config.azureApiVersion || ''}
                onChange={event => state.edit(id, { azureApiVersion: event.target.value })}
                className={`flex-1 ${field(isDarkMode)}`}
              />
            </div>
          </>
        )}

        {type !== ProviderTypeEnum.AzureOpenAI && (
          <div className="flex items-start">
            <label htmlFor={`${id}-models-input`} className={`pt-2 ${labelClass(isDarkMode)}`}>
              {t('options_models_providers_models')}
            </label>
            <div className="flex-1 space-y-2">
              <div
                className={`flex min-h-[42px] flex-wrap items-center gap-2 rounded-md border ${isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-200' : 'border-gray-300 bg-white text-gray-700'} p-2`}>
                {models.length === 0 && type === ProviderTypeEnum.OpenRouter && (
                  <span className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                    {t('options_models_providers_models_openrouter_empty')}
                  </span>
                )}
                <Chips
                  values={models}
                  isDarkMode={isDarkMode}
                  onRemove={value => state.edit(id, { modelNames: models.filter(model => model !== value) })}
                />
                <input
                  id={`${id}-models-input`}
                  type="text"
                  list={`${id}-models-listed`}
                  value={newModel}
                  onChange={event => setNewModel(event.target.value)}
                  onKeyDown={onModelKey}
                  className={`min-w-[150px] flex-1 border-none bg-transparent p-1 text-sm outline-none ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`}
                />
                <datalist id={`${id}-models-listed`}>
                  {listed.slice(0, 500).map(model => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              </div>
              <p className={`mt-1 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                {t('options_models_providers_models_instructions')}
                {row.modelCount > 0 && ` ${t('models_options_listed', [String(row.modelCount)])}`}
              </p>
            </div>
          </div>
        )}

        {problem && editing && (
          <p className={`ml-24 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t(problem)}</p>
        )}
        {line && (
          <p
            role={line.alert ? 'alert' : 'status'}
            className={`ml-24 text-xs ${line.alert ? (isDarkMode ? 'text-red-400' : 'text-red-500') : isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            {line.text}
          </p>
        )}

        {type === ProviderTypeEnum.Ollama && (
          <div
            className={`mt-4 rounded-md border ${isDarkMode ? 'border-slate-600 bg-slate-700' : 'border-blue-100 bg-blue-50'} p-3`}>
            <p className={`text-sm ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`}>
              <strong>
                <code
                  className={`rounded italic ${isDarkMode ? 'bg-slate-600 px-1 py-0.5' : 'bg-blue-100 px-1 py-0.5'}`}>
                  OLLAMA_ORIGINS=chrome-extension://*
                </code>{' '}
              </strong>
              {t('options_models_providers_ollama_reminder')}
              <a
                href="https://github.com/ollama/ollama/blob/main/docs/faq.md#how-can-i-allow-additional-web-origins-to-access-ollama"
                target="_blank"
                rel="noopener noreferrer"
                className={`ml-1 ${isDarkMode ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-800'}`}>
                {t('options_models_providers_ollama_learnMore')}
              </a>
            </p>
            <p className={`mt-2 text-sm ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`}>
              {t('options_models_providers_ollama_contextReminder')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
