import { useMemo, useState } from 'react';
import { ArrowLeft, KeyRound, LogIn, LogOut, RefreshCw, Trash2 } from 'lucide-react';
import { t } from '@extension/i18n';
import { connectorToolState, db } from '@extension/storage';
import type { ConnectorRecord, ToolFingerprint, ToolPolicy } from '@extension/storage';
import { cn } from '@extension/ui';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { useLive } from '../hooks/useLive';
import { inputClass, Section } from '../models/ui';
import type { PanelApi } from '../registry';
import { hostOf, lastErrorText, STATUS_LABEL, statusTone } from './meta';
import { runSignIn, SignInCancelled } from './signIn';
import { ToolRow } from './ToolRow';
import { WorkspaceChecks } from './WorkspaceChecks';

const STATE_ORDER = { new: 0, changed: 0, ok: 1, missing: 2 } as const;

function sortTools(tools: ToolFingerprint[]): ToolFingerprint[] {
  return [...tools].sort(
    (a, b) => STATE_ORDER[connectorToolState(a)] - STATE_ORDER[connectorToolState(b)] || a.tool.localeCompare(b.tool),
  );
}

/**
 * One connector: whether it works, which workspaces may use it, its sign-in, and its tools with the user's
 * choice for each. New and changed tools come first and stay off until the user chooses.
 */
export default function ConnectorDetail({ api, id, onBack }: { api: PanelApi; id: string; onBack: () => void }) {
  const connector = useLive(() => db.connectors.get(id), [id], undefined as ConnectorRecord | undefined);
  const fingerprints = useLive(
    () => db.toolFingerprints.where('connectorId').equals(id).toArray(),
    [id],
    [] as ToolFingerprint[],
  );
  const tools = useMemo(() => sortTools(fingerprints), [fingerprints]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; alert: boolean } | null>(null);
  const [newToken, setNewToken] = useState('');
  const [replacingToken, setReplacingToken] = useState(false);
  const [removing, setRemoving] = useState(false);

  if (!connector) {
    return (
      <div className="flex flex-col gap-3">
        <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
          <ArrowLeft className="size-4" /> {t('conn_back')}
        </Button>
        <p className="text-muted-foreground text-[12.5px]">{t('conn_detail_gone')}</p>
      </div>
    );
  }

  const run = async (label: string, work: () => Promise<string | null>) => {
    setBusy(label);
    setNotice(null);
    try {
      const text = await work();
      if (text) setNotice({ text, alert: false });
    } catch (problem) {
      setNotice({
        text:
          problem instanceof SignInCancelled
            ? t('conn_signIn_cancelled')
            : problem instanceof Error
              ? problem.message
              : String(problem),
        alert: !(problem instanceof SignInCancelled),
      });
    } finally {
      setBusy(null);
    }
  };

  const refresh = () =>
    run('refresh', async () => {
      const reply = await api.request<{ tools: number; added: string[]; changed: string[] }>(
        { type: 'conn_refresh', id },
        90_000,
      );
      return t('conn_refresh_done', [String(reply.tools), String(reply.added.length), String(reply.changed.length)]);
    });

  const signIn = () =>
    run('signIn', async () => {
      const result = await runSignIn(api, id);
      if (result.refreshError) return t('conn_signIn_doneNoTools', [result.refreshError]);
      return t('conn_signIn_done', [String(result.tools ?? 0)]);
    });

  const choose = async (tool: ToolFingerprint, policy: ToolPolicy) => {
    setNotice(null);
    try {
      await api.request({ type: 'conn_tool_policy', id, tool: tool.tool, hash: tool.hash, policy });
    } catch (problem) {
      setNotice({ text: problem instanceof Error ? problem.message : String(problem), alert: true });
    }
  };

  const reviewable = tools.filter(tool => connectorToolState(tool) === 'new');
  const waiting = tools.filter(tool => ['new', 'changed'].includes(connectorToolState(tool))).length;
  const errorText = lastErrorText(connector);

  return (
    <div className="flex flex-col gap-4" data-connector={connector.name}>
      <div className="flex items-start gap-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label={t('conn_back')}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold">{connector.name}</h2>
          <div className="text-muted-foreground truncate font-mono text-[11px]">{hostOf(connector.url)}</div>
        </div>
        <Switch
          checked={connector.status !== 'disabled'}
          label={t('conn_detail_enabled', [connector.name])}
          disabled={busy !== null}
          onChange={enabled =>
            void run('enable', async () => {
              await api.request({ type: 'conn_update', id, enabled }, 90_000);
              return null;
            })
          }
        />
      </div>

      <div className="glass rounded-2xl p-3 text-[12.5px]" data-connector-status={connector.status}>
        <div className="flex items-center gap-2">
          <span className={cn('size-2 shrink-0 rounded-full', statusTone(connector.status))} aria-hidden />
          <span className="font-medium">{t(STATUS_LABEL[connector.status])}</span>
          {connector.credential?.last4 && (
            <span className="text-muted-foreground font-mono text-[11px]">••••{connector.credential.last4}</span>
          )}
        </div>
        {errorText && <p className="text-muted-foreground mt-1">{errorText}</p>}
        {connector.status === 'needs_auth' && connector.authKind === 'oauth' && (
          <p className="mt-1">{t('conn_detail_needsSignIn')}</p>
        )}
        <div className="mt-2.5 flex flex-wrap gap-2">
          {connector.authKind === 'oauth' && (
            <Button
              size="sm"
              variant={connector.status === 'needs_auth' ? 'hold' : 'glass'}
              disabled={busy !== null || connector.status === 'disabled'}
              onClick={() => void signIn()}>
              <LogIn className="size-3.5" />
              {busy === 'signIn'
                ? t('conn_signIn_busy')
                : connector.credential
                  ? t('conn_signIn_reconnect')
                  : t('conn_signIn_start')}
            </Button>
          )}
          {connector.authKind === 'token' && (
            <Button size="sm" variant="glass" disabled={busy !== null} onClick={() => setReplacingToken(open => !open)}>
              <KeyRound className="size-3.5" />
              {connector.credential ? t('conn_token_replace') : t('conn_token_add')}
            </Button>
          )}
          <Button
            size="sm"
            variant="glass"
            disabled={busy !== null || connector.status === 'disabled' || connector.status === 'needs_auth'}
            onClick={() => void refresh()}>
            <RefreshCw className={cn('size-3.5', busy === 'refresh' && 'animate-spin')} />
            {t('conn_detail_refresh')}
          </Button>
        </div>
        {replacingToken && (
          <form
            className="mt-2 flex items-center gap-1.5"
            onSubmit={event => {
              event.preventDefault();
              const token = newToken.trim();
              if (!token) return;
              setNewToken('');
              setReplacingToken(false);
              void run('token', async () => {
                await api.request({ type: 'conn_update', id, token }, 90_000);
                return t('conn_token_saved');
              });
            }}>
            <label htmlFor="conn-new-token" className="sr-only">
              {t('conn_add_token')}
            </label>
            <input
              id="conn-new-token"
              type="password"
              autoComplete="off"
              value={newToken}
              onChange={event => setNewToken(event.target.value)}
              className={`${inputClass} font-mono`}
            />
            <Button type="submit" size="sm" disabled={!newToken.trim()}>
              {t('conn_save')}
            </Button>
          </form>
        )}
        {notice && (
          <p role={notice.alert ? 'alert' : 'status'} className={cn('mt-2', notice.alert && 'text-destructive')}>
            {notice.text}
          </p>
        )}
      </div>

      <section aria-label={t('conn_workspaces')}>
        <h3 className="label-mono mb-1.5 px-1">{t('conn_workspaces')}</h3>
        <WorkspaceChecks
          value={connector.workspaceIds}
          disabled={busy !== null}
          onChange={workspaceIds =>
            void run('workspaces', async () => {
              await api.request({ type: 'conn_update', id, workspaceIds });
              return null;
            })
          }
        />
        {connector.workspaceIds.length === 0 && (
          <p className="text-muted-foreground mt-1 text-[11.5px]">{t('conn_workspacesEmpty')}</p>
        )}
      </section>

      <Section
        label={t('conn_tools_title', [String(tools.filter(tool => !tool.missing).length)])}
        action={
          reviewable.length > 1 ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() =>
                void run('review', async () => {
                  await api.request({
                    type: 'conn_tools_review',
                    id,
                    policy: 'approve',
                    tools: reviewable.map(tool => ({ tool: tool.tool, hash: tool.hash })),
                  });
                  return null;
                })
              }>
              {t('conn_tools_allAsk')}
            </Button>
          ) : undefined
        }>
        {waiting > 0 && (
          <div className="px-3 py-2 text-[12px]">
            <Badge variant="hold">{t('conn_tools_waiting', [String(waiting)])}</Badge>
            <p className="text-muted-foreground mt-1">{t('conn_tools_waitingHint')}</p>
          </div>
        )}
        {tools.length === 0 ? (
          <p className="text-muted-foreground p-3 text-[12.5px]">
            {connector.status === 'needs_auth' ? t('conn_tools_signInFirst') : t('conn_tools_none')}
          </p>
        ) : (
          <ul className="divide-border/60 divide-y">
            {tools.map(tool => (
              <ToolRow key={tool.id} connector={connector} tool={tool} onChoose={policy => choose(tool, policy)} />
            ))}
          </ul>
        )}
      </Section>

      <div className="flex flex-col gap-2">
        {!removing ? (
          <div className="flex flex-wrap gap-1">
            {connector.authKind !== 'none' && connector.credential && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  void run('signOut', async () => {
                    await api.request({ type: 'conn_sign_out', id });
                    return t('conn_signOut_done');
                  })
                }>
                <LogOut className="size-3.5" />
                {t('conn_signOut')}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setRemoving(true)}>
              <Trash2 className="size-3.5" />
              {t('conn_detail_remove')}
            </Button>
          </div>
        ) : (
          <div role="alert" className="border-destructive/40 rounded-xl border p-2.5 text-[12.5px]">
            <p>{t('conn_remove_confirm', [connector.name])}</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="glass" onClick={() => setRemoving(false)}>
                {t('conn_cancel')}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() =>
                  void run('remove', async () => {
                    await api.request({ type: 'conn_remove', id });
                    onBack();
                    return null;
                  })
                }>
                {t('conn_detail_remove')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
