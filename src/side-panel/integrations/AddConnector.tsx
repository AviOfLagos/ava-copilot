import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ArrowLeft, Copy, ExternalLink } from 'lucide-react';
import { t } from '@extension/i18n';
import { checkConnectorUrl, connectorCatalogEntry } from '@extension/storage';
import type { ConnectorCatalogId } from '@extension/storage';
import { Button } from '../components/ui/button';
import { inputClass, Segmented } from '../models/ui';
import type { PanelApi } from '../registry';
import { CATALOG_HOW } from './meta';
import { WorkspaceChecks } from './WorkspaceChecks';

type AuthKind = 'none' | 'token' | 'oauth';

function redirectUrl(): string {
  try {
    return chrome.identity.getRedirectURL();
  } catch {
    return '';
  }
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="text-muted-foreground mb-0.5 block text-[11px]">
        {label}
      </label>
      {children}
      {hint && <p className="text-muted-foreground mt-0.5 text-[11px]">{hint}</p>}
    </div>
  );
}

/**
 * Adding a connector: a well-known server (its address and sign-in are known) or any MCP server by its address.
 * The user picks the workspaces that may use it; a token or client secret goes straight to the background's
 * vault and is never shown again.
 */
export default function AddConnector({
  api,
  catalogId,
  onCancel,
  onAdded,
}: {
  api: PanelApi;
  catalogId: ConnectorCatalogId | null;
  onCancel: () => void;
  onAdded: (id: string) => void;
}) {
  const entry = connectorCatalogEntry(catalogId);
  const [name, setName] = useState(entry?.name ?? '');
  const [url, setUrl] = useState(entry?.url ?? '');
  const [authKind, setAuthKind] = useState<AuthKind>(entry?.auth ?? 'none');
  const [token, setToken] = useState('');
  const [tokenHeader, setTokenHeader] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [scope, setScope] = useState('');
  const [timeoutSec, setTimeoutSec] = useState('');
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([]);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const redirect = redirectUrl();

  const urlCheck = url.trim() ? checkConnectorUrl(url) : null;
  const urlError =
    urlCheck && 'error' in urlCheck
      ? t(
          urlCheck.error === 'insecure'
            ? 'conn_add_urlInsecure'
            : urlCheck.error === 'credentials'
              ? 'conn_add_urlCredentials'
              : 'conn_add_urlInvalid',
        )
      : null;
  const needsClient = authKind === 'oauth' && (entry?.needsClient ?? false);
  const canSubmit =
    !busy &&
    (entry || (name.trim() && urlCheck && !('error' in urlCheck))) &&
    (authKind !== 'token' || token.trim()) &&
    (!needsClient || clientId.trim());

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const seconds = Number(timeoutSec);
      const reply = await api.request<{ id: string }>(
        {
          type: 'conn_add',
          name: name.trim() || entry?.name || '',
          url: entry ? undefined : url.trim(),
          authKind: entry ? undefined : authKind,
          catalogId: entry?.id ?? null,
          token: authKind === 'token' ? token.trim() : undefined,
          tokenHeader: authKind === 'token' && tokenHeader.trim() ? tokenHeader.trim() : undefined,
          clientId: authKind === 'oauth' && clientId.trim() ? clientId.trim() : undefined,
          clientSecret: authKind === 'oauth' && clientSecret.trim() ? clientSecret.trim() : undefined,
          scope: authKind === 'oauth' && !entry && scope.trim() ? scope.trim() : undefined,
          workspaceIds,
          timeoutSec: Number.isFinite(seconds) && seconds >= 2 && seconds <= 120 ? Math.round(seconds) : undefined,
        },
        90_000,
      );
      // The fields that held secrets are emptied at once
      setToken('');
      setClientSecret('');
      onAdded(reply.id);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-labelledby="conn-add-title">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" onClick={onCancel} aria-label={t('conn_back')}>
          <ArrowLeft className="size-4" />
        </Button>
        <h2 id="conn-add-title" className="text-[15px] font-semibold">
          {entry ? t('conn_add_titleNamed', [entry.name]) : t('conn_add_titleCustom')}
        </h2>
      </div>

      {entry && (
        <div className="glass rounded-2xl p-3 text-[12.5px]">
          <p>{t(CATALOG_HOW[entry.id])}</p>
          <p className="text-muted-foreground mt-1 break-all font-mono text-[11px]">{entry.url}</p>
          <a
            href={entry.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="text-primary mt-1.5 inline-flex items-center gap-1 text-[12px] underline-offset-2 hover:underline">
            {t('conn_add_docs')} <ExternalLink className="size-3" aria-hidden />
          </a>
        </div>
      )}

      {!entry && (
        <>
          <Field id="conn-name" label={t('conn_add_name')}>
            <input
              id="conn-name"
              value={name}
              onChange={event => setName(event.target.value)}
              maxLength={60}
              placeholder={t('conn_add_namePlaceholder')}
              className={inputClass}
            />
          </Field>
          <Field id="conn-url" label={t('conn_add_url')} hint={urlError ?? t('conn_add_urlHint')}>
            <input
              id="conn-url"
              type="url"
              value={url}
              onChange={event => setUrl(event.target.value)}
              placeholder="https://example.com/mcp"
              aria-invalid={Boolean(urlError)}
              className={`${inputClass} font-mono`}
            />
          </Field>
          <div>
            <span className="text-muted-foreground mb-1 block text-[11px]">{t('conn_add_auth')}</span>
            <Segmented
              label={t('conn_add_auth')}
              value={authKind}
              onChange={setAuthKind}
              options={[
                { value: 'none', label: t('conn_auth_none') },
                { value: 'token', label: t('conn_auth_token') },
                { value: 'oauth', label: t('conn_auth_oauth') },
              ]}
            />
          </div>
        </>
      )}

      {authKind === 'token' && (
        <Field id="conn-token" label={t('conn_add_token')} hint={t('conn_add_tokenHint')}>
          <input
            id="conn-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={event => setToken(event.target.value)}
            className={`${inputClass} font-mono`}
          />
        </Field>
      )}

      {authKind === 'oauth' && (needsClient || advanced) && (
        <div className="space-y-2">
          {redirect && (
            <div className="text-[11.5px]">
              <span className="text-muted-foreground block">{t('conn_add_redirect')}</span>
              <span className="flex items-center gap-1">
                <code className="bg-muted/60 min-w-0 flex-1 break-all rounded px-1.5 py-0.5 text-[11px]">
                  {redirect}
                </code>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('conn_add_copyRedirect')}
                  onClick={() => void navigator.clipboard?.writeText(redirect).catch(() => {})}>
                  <Copy className="size-3.5" />
                </Button>
              </span>
            </div>
          )}
          <Field id="conn-client-id" label={t('conn_add_clientId')}>
            <input
              id="conn-client-id"
              value={clientId}
              onChange={event => setClientId(event.target.value)}
              autoComplete="off"
              className={`${inputClass} font-mono`}
            />
          </Field>
          <Field id="conn-client-secret" label={t('conn_add_clientSecret')} hint={t('conn_add_clientSecretHint')}>
            <input
              id="conn-client-secret"
              type="password"
              autoComplete="off"
              value={clientSecret}
              onChange={event => setClientSecret(event.target.value)}
              className={`${inputClass} font-mono`}
            />
          </Field>
        </div>
      )}

      <div>
        <span className="text-muted-foreground mb-1 block text-[11px]">{t('conn_workspaces')}</span>
        <WorkspaceChecks value={workspaceIds} onChange={setWorkspaceIds} />
        <p className="text-muted-foreground mt-1 text-[11px]">{t('conn_workspacesHint')}</p>
      </div>

      {!entry && (
        <div>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground text-[11.5px] underline-offset-2 hover:underline"
            aria-expanded={advanced}
            onClick={() => setAdvanced(open => !open)}>
            {advanced ? t('conn_add_lessOptions') : t('conn_add_moreOptions')}
          </button>
          {advanced && (
            <div className="mt-2 space-y-2">
              {authKind === 'token' && (
                <Field id="conn-header" label={t('conn_add_tokenHeader')} hint={t('conn_add_tokenHeaderHint')}>
                  <input
                    id="conn-header"
                    value={tokenHeader}
                    onChange={event => setTokenHeader(event.target.value)}
                    placeholder="Authorization"
                    className={`${inputClass} font-mono`}
                  />
                </Field>
              )}
              {authKind === 'oauth' && (
                <Field id="conn-scope" label={t('conn_add_scope')} hint={t('conn_add_scopeHint')}>
                  <input
                    id="conn-scope"
                    value={scope}
                    onChange={event => setScope(event.target.value)}
                    className={`${inputClass} font-mono`}
                  />
                </Field>
              )}
              <Field id="conn-timeout" label={t('conn_add_timeout')} hint={t('conn_add_timeoutHint')}>
                <input
                  id="conn-timeout"
                  type="number"
                  min={2}
                  max={120}
                  value={timeoutSec}
                  onChange={event => setTimeoutSec(event.target.value)}
                  placeholder="30"
                  className={`${inputClass} w-24`}
                />
              </Field>
            </div>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="glass" className="flex-1" onClick={onCancel}>
          {t('conn_cancel')}
        </Button>
        <Button type="submit" className="flex-[1.4]" disabled={!canSubmit}>
          {busy ? t('conn_add_adding') : t('conn_add_submit')}
        </Button>
      </div>
    </form>
  );
}
