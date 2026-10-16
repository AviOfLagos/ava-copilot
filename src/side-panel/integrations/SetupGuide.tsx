import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Check, Loader2, Sparkles, X } from 'lucide-react';
import { t } from '@extension/i18n';
import { connectorCatalogEntry, db, VAULT_STATE_KEY, workspaceStore } from '@extension/storage';
import type { ConnectorCatalogId, ConnectorRecord } from '@extension/storage';
import { cn } from '@extension/ui';
import { Button } from '../components/ui/button';
import { useLive } from '../hooks/useLive';
import { inputClass } from '../models/ui';
import type { PanelApi } from '../registry';
import VaultSettings from '../vault/VaultSettings';

/**
 * "Set it up with Ava": a guided setup in the panel. Each step comes from the background (`conn_setup`), which
 * does what it can itself — adds the connector, opens the sign-in or developer page in a tab — and says what is
 * left for the user. Secrets the user has to bring (a token, a client secret) go into the fields here, straight
 * to the vault; Ava never sees them and never presses a consent button. The guide carries on by itself when the
 * connector or the vault changes, and with "Carry on" when the user says they are done.
 */

export type SetupTarget = ConnectorCatalogId | 'custom' | 'obsidian' | 'models';

export interface SetupStepView {
  target: SetupTarget;
  stage: string;
  say: string;
  opened: string[];
  connectorId: string | null;
  done: boolean;
}

export function SetupGuide({
  api,
  target,
  url: initialUrl,
  onClose,
  onOpenConnector,
}: {
  api: PanelApi;
  target: SetupTarget;
  // A custom server's address, when it is known already
  url?: string;
  onClose: () => void;
  onOpenConnector?: (id: string) => void;
}) {
  const [step, setStep] = useState<SetupStepView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const urlRef = useRef(initialUrl ?? '');
  const entry = connectorCatalogEntry(target);

  const advance = useCallback(
    async (extra: { open?: boolean } = {}) => {
      setBusy(true);
      setError(null);
      try {
        const next = await api.request<SetupStepView>(
          { type: 'conn_setup', target, url: urlRef.current || undefined, ...extra },
          90_000,
        );
        setStep(next);
      } catch (problem) {
        setError(problem instanceof Error ? problem.message : String(problem));
      } finally {
        setBusy(false);
      }
    },
    [api, target],
  );

  // The first step when the guide opens: once, as it may open a tab
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void advance();
  }, [advance]);

  // A connector that signs in, or loses its sign-in, moves the guide on without a click
  const connectorId = step?.connectorId ?? null;
  const connector = useLive(
    () => (connectorId ? db.connectors.get(connectorId) : Promise.resolve(undefined)),
    [connectorId],
    undefined as ConnectorRecord | undefined,
  );
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    if (!connector) return;
    const changed = lastStatus.current !== null && lastStatus.current !== connector.status;
    lastStatus.current = connector.status;
    // Only look again: a step that would open a page again waits for the user's "Carry on"
    if (changed) void advance({ open: false });
  }, [connector, advance]);

  // So does the vault, which an extension page writes about
  useEffect(() => {
    if (target !== 'obsidian') return;
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[VAULT_STATE_KEY]) void advance({ open: false });
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [target, advance]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
      setBusy(false);
      return;
    }
    setBusy(false);
    await advance();
  };

  const submitUrl = (event: FormEvent) => {
    event.preventDefault();
    urlRef.current = url.trim();
    if (urlRef.current) void advance();
  };

  const submitToken = (event: FormEvent) => {
    event.preventDefault();
    const token = secret.trim();
    if (!token || !connectorId) return;
    setSecret('');
    void run(() => api.request({ type: 'conn_update', id: connectorId, token }, 90_000));
  };

  const submitClient = (event: FormEvent) => {
    event.preventDefault();
    if (!clientId.trim() || !entry) return;
    const secretValue = clientSecret.trim();
    setClientSecret('');
    void run(async () => {
      if (connectorId) {
        await api.request(
          { type: 'conn_update', id: connectorId, clientId: clientId.trim(), clientSecret: secretValue || undefined },
          90_000,
        );
        return;
      }
      const workspaceId = await workspaceStore.getDefaultWorkspaceId().catch(() => null);
      await api.request(
        {
          type: 'conn_add',
          name: entry.name,
          catalogId: entry.id,
          clientId: clientId.trim(),
          clientSecret: secretValue || undefined,
          workspaceIds: workspaceId ? [workspaceId] : [],
        },
        90_000,
      );
    });
  };

  const title = entry?.name ?? (target === 'obsidian' ? 'Obsidian' : target === 'models' ? t('conn_setup_models') : '');

  return (
    <section
      className="glass border-primary/30 rounded-2xl border p-3 text-[12.5px]"
      aria-label={t('conn_setup_title', [title || t('conn_custom_title')])}
      data-setup={target}
      data-setup-stage={step?.stage ?? 'loading'}>
      <div className="flex items-center gap-2">
        <Sparkles className="text-primary size-4 shrink-0" aria-hidden />
        <h3 className="flex-1 text-[13px] font-medium">{t('conn_setup_title', [title || t('conn_custom_title')])}</h3>
        <Button variant="ghost" size="icon-sm" aria-label={t('conn_setup_close')} onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="mt-2 flex items-start gap-2" role="status" aria-live="polite">
        {busy && !step ? (
          <Loader2 className="text-muted-foreground mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden />
        ) : step?.done ? (
          <Check className="text-primary mt-0.5 size-3.5 shrink-0" aria-hidden />
        ) : null}
        <p className="whitespace-pre-line" data-setup-say>
          {step?.say ?? t('conn_setup_starting')}
        </p>
      </div>
      {step && step.opened.length > 0 && (
        <p className="text-muted-foreground mt-1 text-[11.5px]">
          {t('conn_setup_opened', [String(step.opened.length)])}
        </p>
      )}

      {step?.stage === 'needs_url' && (
        <form className="mt-2 flex items-center gap-1.5" onSubmit={submitUrl}>
          <label htmlFor="setup-url" className="sr-only">
            {t('conn_add_url')}
          </label>
          <input
            id="setup-url"
            type="url"
            value={url}
            onChange={event => setUrl(event.target.value)}
            placeholder="https://example.com/mcp"
            className={`${inputClass} font-mono`}
          />
          <Button type="submit" size="sm" disabled={!url.trim() || busy}>
            {t('conn_setup_next')}
          </Button>
        </form>
      )}

      {step?.stage === 'needs_token' && connectorId && (
        <form className="mt-2 flex items-center gap-1.5" onSubmit={submitToken}>
          <label htmlFor="setup-token" className="sr-only">
            {t('conn_add_token')}
          </label>
          <input
            id="setup-token"
            type="password"
            autoComplete="off"
            value={secret}
            onChange={event => setSecret(event.target.value)}
            placeholder={t('conn_add_token')}
            className={`${inputClass} font-mono`}
          />
          <Button type="submit" size="sm" disabled={!secret.trim() || busy}>
            {t('conn_save')}
          </Button>
        </form>
      )}

      {step?.stage === 'needs_client' && entry && (
        <form className="mt-2 space-y-1.5" onSubmit={submitClient}>
          <label htmlFor="setup-client-id" className="text-muted-foreground block text-[11px]">
            {t('conn_add_clientId')}
          </label>
          <input
            id="setup-client-id"
            autoComplete="off"
            value={clientId}
            onChange={event => setClientId(event.target.value)}
            className={`${inputClass} font-mono`}
          />
          <label htmlFor="setup-client-secret" className="text-muted-foreground block text-[11px]">
            {t('conn_add_clientSecret')}
          </label>
          <input
            id="setup-client-secret"
            type="password"
            autoComplete="off"
            value={clientSecret}
            onChange={event => setClientSecret(event.target.value)}
            className={`${inputClass} font-mono`}
          />
          <Button type="submit" size="sm" disabled={!clientId.trim() || busy}>
            {t('conn_setup_saveClient')}
          </Button>
        </form>
      )}

      {target === 'obsidian' && step && !step.done && (
        <div className="bg-card/40 -mx-1 mt-2 rounded-xl">
          <VaultSettings />
        </div>
      )}

      {error && (
        <p role="alert" className="text-destructive mt-2">
          {error}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap gap-2">
        {step?.stage === 'signing_in' && (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[11.5px]">
            <Loader2 className="size-3 animate-spin" aria-hidden />
            {t('conn_setup_waiting')}
          </span>
        )}
        {step && !step.done && (
          <Button
            size="sm"
            variant={step.stage === 'signing_in' || step.stage === 'needs_token' ? 'glass' : 'default'}
            disabled={busy}
            onClick={() => void advance()}>
            {busy ? t('conn_setup_checking') : t('conn_setup_carryOn')}
          </Button>
        )}
        {step?.stage === 'models_key' && (
          <Button size="sm" variant="glass" onClick={() => api.go('models')}>
            {t('conn_setup_openModels')}
          </Button>
        )}
        {connectorId && onOpenConnector && (step?.stage === 'review_tools' || step?.done) && (
          <Button
            size="sm"
            variant={step?.stage === 'review_tools' ? 'hold' : 'glass'}
            onClick={() => onOpenConnector(connectorId)}>
            {step?.stage === 'review_tools' ? t('conn_setup_reviewNow') : t('conn_setup_open')}
          </Button>
        )}
        {step?.done && (
          <Button size="sm" variant="ghost" className={cn(!connectorId && 'ml-auto')} onClick={onClose}>
            {t('conn_setup_finish')}
          </Button>
        )}
      </div>
    </section>
  );
}
