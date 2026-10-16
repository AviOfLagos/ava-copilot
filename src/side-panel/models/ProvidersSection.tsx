import { useState } from 'react';
import { Eye, EyeOff, Plus } from 'lucide-react';
import { t } from '@extension/i18n';
import { getDefaultDisplayNameFromProviderId, ProviderTypeEnum, takesBaseUrl } from '@extension/storage';
import type { LocalServerKind, ProviderHint } from '@extension/storage';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { HealthDot, inputClass, Section, timeAgo } from './ui';
import type { ProviderRow, ProvidersState } from './useProviders';

type MessageKey = Parameters<typeof t>[0];

const HINTS: Record<ProviderHint, MessageKey> = {
  ollama_origins: 'models_hint_ollama_origins',
  needs_key: 'models_hint_needs_key',
  key_rejected: 'models_hint_key_rejected',
  unreachable: 'models_hint_unreachable',
};

/** What the last check said, as a sentence: a fix when there is one. */
function statusLine(row: ProviderRow, state: ProvidersState): { text: string; alert: boolean } | null {
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
  if (state.results[row.id] && health.status === 'ok') {
    return { text: t('models_result_ok', [String(state.results[row.id].models)]), alert: false };
  }
  return null;
}

function ProviderEditor({ row, state }: { row: ProviderRow; state: ProvidersState }) {
  const [showKey, setShowKey] = useState(false);
  const draft = row.draft!;
  const { config } = draft;
  const problem = state.problem(row.id);
  const id = (field: string) => `models-${row.id}-${field}`;

  return (
    <div className="mt-2 space-y-2">
      {row.type === ProviderTypeEnum.CustomOpenAI && (
        <div>
          <label htmlFor={id('name')} className="text-muted-foreground mb-0.5 block text-[11px]">
            {t('models_name')}
          </label>
          <input
            id={id('name')}
            value={config.name ?? ''}
            onChange={event => state.edit(row.id, { name: event.target.value })}
            className={inputClass}
          />
        </div>
      )}
      {takesBaseUrl(row.type) && (
        <div>
          <label htmlFor={id('url')} className="text-muted-foreground mb-0.5 block text-[11px]">
            {t('models_baseUrl')}
          </label>
          <input
            id={id('url')}
            type="url"
            value={config.baseUrl ?? ''}
            onChange={event => state.edit(row.id, { baseUrl: event.target.value })}
            placeholder="https://…/v1"
            className={`${inputClass} font-mono`}
          />
        </div>
      )}
      {row.type === ProviderTypeEnum.AzureOpenAI && (
        <>
          <div>
            <label htmlFor={id('deployments')} className="text-muted-foreground mb-0.5 block text-[11px]">
              {t('models_deployments')}
            </label>
            <input
              id={id('deployments')}
              value={(config.azureDeploymentNames ?? []).join(', ')}
              onChange={event =>
                state.edit(row.id, {
                  azureDeploymentNames: event.target.value
                    .split(',')
                    .map(name => name.trim())
                    .filter(Boolean),
                })
              }
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={id('version')} className="text-muted-foreground mb-0.5 block text-[11px]">
              {t('models_apiVersion')}
            </label>
            <input
              id={id('version')}
              value={config.azureApiVersion ?? ''}
              onChange={event => state.edit(row.id, { azureApiVersion: event.target.value })}
              className={`${inputClass} font-mono`}
            />
          </div>
        </>
      )}
      <div>
        <label htmlFor={id('key')} className="text-muted-foreground mb-0.5 block text-[11px]">
          {t('models_key_label')}
          {row.hasKey && ` · ${row.keyDisplay}`}
        </label>
        <div className="flex items-center gap-1">
          <input
            id={id('key')}
            type={showKey ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            value={draft.apiKey}
            onChange={event => state.setKey(row.id, event.target.value)}
            placeholder={row.hasKey ? t('models_key_keepPlaceholder') : t('models_key_placeholder')}
            className={`${inputClass} font-mono`}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={showKey ? t('models_key_hide') : t('models_key_show')}
            onClick={() => setShowKey(!showKey)}>
            {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </Button>
        </div>
      </div>
      {problem && <p className="text-muted-foreground text-[11.5px]">{t(problem)}</p>}
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" disabled={!!problem || !!state.busy[row.id]} onClick={() => void state.save(row.id)}>
          {t('models_save')}
        </Button>
        <Button
          size="sm"
          variant="glass"
          disabled={!!state.busy[row.id] || (!!problem && problem !== 'models_problem_key')}
          onClick={() => void state.check(row.id)}>
          {t('models_test')}
        </Button>
        <Button size="sm" variant="ghost" disabled={!!state.busy[row.id]} onClick={() => state.cancel(row.id)}>
          {t('models_cancel')}
        </Button>
        {/* A provider that needs a key gets a new one or is removed; only optional keys can go */}
        {row.hasKey && row.keyOptional && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void state.removeKey(row.id).then(() => state.cancel(row.id))}>
            {t('models_key_remove')}
          </Button>
        )}
      </div>
    </div>
  );
}

function ProviderItem({ row, state }: { row: ProviderRow; state: ProvidersState }) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const name = row.config.name || getDefaultDisplayNameFromProviderId(row.id);
  const status = statusLine(row, state);
  const editing = Boolean(row.draft);
  const health = state.results[row.id]?.health?.status ?? row.health?.status ?? null;

  return (
    <div className="px-3 py-2.5" data-provider={row.id}>
      <div className="flex items-center gap-2">
        <HealthDot status={row.saved ? health : null} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{name}</span>
        <Badge variant={row.local ? 'default' : 'outline'}>
          {row.local ? t('models_provider_local') : t('models_provider_cloud')}
        </Badge>
        {row.modelCount > 0 && (
          <span className="text-muted-foreground font-mono text-[11px]">
            {t('models_provider_models', [String(row.modelCount)])}
          </span>
        )}
      </div>

      {!editing && (
        <>
          <div className="mt-0.5 flex items-center gap-2 pl-4">
            <span className="text-muted-foreground font-mono text-[11.5px]" data-key-display>
              {row.hasKey ? row.keyDisplay : row.keyOptional ? t('models_key_notNeeded') : t('models_key_none')}
            </span>
            {row.health?.checkedAt ? (
              <span className="text-muted-foreground ml-auto font-mono text-[10.5px]" data-checked-at>
                {t('models_provider_checked', [timeAgo(row.health.checkedAt)])}
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex items-center justify-end gap-0.5">
            <Button size="sm" variant="ghost" onClick={() => state.edit(row.id, {})}>
              {row.hasKey ? t('models_key_replace') : t('models_edit')}
            </Button>
            <Button size="sm" variant="ghost" disabled={!!state.busy[row.id]} onClick={() => void state.check(row.id)}>
              {t('models_test')}
            </Button>
            <Button
              size="sm"
              variant={confirmRemove ? 'destructive' : 'ghost'}
              onBlur={() => setConfirmRemove(false)}
              onClick={() => {
                if (!confirmRemove) setConfirmRemove(true);
                else void state.remove(row.id);
              }}>
              {confirmRemove ? t('models_removeConfirm') : t('models_remove')}
            </Button>
          </div>
        </>
      )}

      {editing && <ProviderEditor row={row} state={state} />}

      {status && (
        <p
          role={status.alert ? 'alert' : 'status'}
          className={`mt-1 text-[11.5px] ${status.alert ? 'text-destructive' : 'text-muted-foreground'}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}

const LOCAL_NAMES: Record<LocalServerKind, string> = { ollama: 'Ollama', lmstudio: 'LM Studio' };

/** Model servers found on this Mac that are not set up yet: one click adds them. */
function LocalOffers({ state }: { state: ProvidersState }) {
  const offers = (Object.values(state.health.local) ?? []).filter(
    probe =>
      probe &&
      probe.status !== 'absent' &&
      !state.saved[probe.kind === 'ollama' ? ProviderTypeEnum.Ollama : ProviderTypeEnum.LMStudio],
  );
  if (offers.length === 0) return null;
  return (
    <>
      {offers.map(probe => (
        <div key={probe.kind} className="flex items-center gap-2 px-3 py-2.5" data-local-offer={probe.kind}>
          <p className="min-w-0 flex-1 text-[12px]">
            {probe.status === 'found'
              ? t('models_local_found', [LOCAL_NAMES[probe.kind], String(probe.models.length)])
              : t('models_local_refused', [LOCAL_NAMES[probe.kind]])}
            {probe.status === 'refused' && probe.kind === 'ollama' && (
              <span className="text-muted-foreground mt-0.5 block text-[11.5px]">
                {t('models_hint_ollama_origins')}
              </span>
            )}
          </p>
          {probe.status === 'found' && (
            <Button size="sm" variant="glass" onClick={() => void state.addLocal(probe.kind)}>
              {t('models_local_add', [LOCAL_NAMES[probe.kind]])}
            </Button>
          )}
        </div>
      ))}
    </>
  );
}

function AddProvider({ state }: { state: ProvidersState }) {
  const [choice, setChoice] = useState('');
  return (
    <div className="flex items-center gap-2 px-3 py-2.5">
      <label htmlFor="models-add-provider" className="sr-only">
        {t('models_add_choose')}
      </label>
      <select
        id="models-add-provider"
        value={choice}
        onChange={event => setChoice(event.target.value)}
        className={`${inputClass} flex-1`}>
        <option value="">{t('models_add_choose')}</option>
        {state.addableTypes.map(type => (
          <option key={type} value={type}>
            {type === ProviderTypeEnum.CustomOpenAI
              ? t('options_models_providers_openaiCompatible')
              : getDefaultDisplayNameFromProviderId(type)}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="glass"
        disabled={!choice}
        onClick={() => {
          state.add(choice as ProviderTypeEnum);
          setChoice('');
        }}>
        <Plus className="size-3.5" />
        {t('models_add')}
      </Button>
    </div>
  );
}

export default function ProvidersSection({ state }: { state: ProvidersState }) {
  return (
    <Section label={t('models_providers')}>
      {state.rows.length === 0 && state.loaded && (
        <p className="text-muted-foreground px-3 py-2.5 text-[12.5px]">{t('options_models_providers_notConfigured')}</p>
      )}
      {state.rows.map(row => (
        <ProviderItem key={row.id} row={row} state={state} />
      ))}
      <LocalOffers state={state} />
      <AddProvider state={state} />
      <p className="text-muted-foreground px-3 py-2 text-[11px]">{t('models_key_vault')}</p>
    </Section>
  );
}
