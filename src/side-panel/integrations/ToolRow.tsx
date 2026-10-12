import { useState } from 'react';
import { t } from '@extension/i18n';
import { chosenToolPolicy, connectorToolState, toolClaimsReadOnly } from '@extension/storage';
import type { ConnectorRecord, ToolFingerprint, ToolPolicy } from '@extension/storage';
import { cn } from '@extension/ui';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';

type MessageKey = Parameters<typeof t>[0];

const POLICIES: { value: ToolPolicy; label: MessageKey }[] = [
  { value: 'off', label: 'conn_policy_off' },
  { value: 'approve', label: 'conn_policy_approve' },
  { value: 'read', label: 'conn_policy_read' },
];

function argNames(schema: Record<string, unknown> | undefined): string {
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') return '';
  const required = new Set(Array.isArray(schema?.required) ? (schema.required as unknown[]) : []);
  return Object.keys(properties)
    .map(name => (required.has(name) ? `${name}*` : name))
    .join(', ');
}

/**
 * One tool of a connector: what it says it does, what it takes, and the user's choice — off, ask first, or run
 * without asking. A tool that is new or changed shows no choice until the user makes one; letting a tool run
 * without asking when its server does not even claim it only reads takes a second, explicit click.
 */
export function ToolRow({
  connector,
  tool,
  onChoose,
}: {
  connector: ConnectorRecord;
  tool: ToolFingerprint;
  onChoose: (policy: ToolPolicy) => Promise<void>;
}) {
  const state = connectorToolState(tool);
  const chosen = state === 'ok' ? chosenToolPolicy(connector, tool.tool) : null;
  const claimsRead = toolClaimsReadOnly(tool);
  const [confirmRead, setConfirmRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const args = argNames(tool.inputSchema);
  const schemaChanged =
    state === 'changed' &&
    tool.previous &&
    JSON.stringify(tool.previous.inputSchema ?? {}) !== JSON.stringify(tool.inputSchema ?? {});

  const choose = async (policy: ToolPolicy) => {
    if (policy === 'read' && !claimsRead && !confirmRead) {
      setConfirmRead(true);
      return;
    }
    setConfirmRead(false);
    setBusy(true);
    try {
      await onChoose(policy);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li data-tool={tool.tool} data-tool-state={state} className="px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 break-all font-mono text-[12.5px] font-medium">{tool.tool}</span>
        {state === 'new' && <Badge variant="hold">{t('conn_tool_new')}</Badge>}
        {state === 'changed' && <Badge variant="hold">{t('conn_tool_changed')}</Badge>}
        {state === 'missing' && <Badge variant="outline">{t('conn_tool_missing')}</Badge>}
        {claimsRead && <Badge variant="outline">{t('conn_tool_saysReadOnly')}</Badge>}
        {tool.annotations?.destructiveHint === true && (
          <Badge variant="outline">{t('conn_tool_saysDestructive')}</Badge>
        )}
      </div>
      {tool.title && tool.title !== tool.tool && <div className="mt-0.5 text-[12px]">{tool.title}</div>}
      {tool.description && (
        <p
          className={cn(
            'text-muted-foreground mt-0.5 whitespace-pre-wrap break-words text-[12px]',
            !open && 'line-clamp-3',
          )}>
          {tool.description}
        </p>
      )}
      {tool.description && tool.description.length > 160 && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline"
          aria-expanded={open}
          onClick={() => setOpen(value => !value)}>
          {open ? t('conn_tool_less') : t('conn_tool_more')}
        </button>
      )}
      {args && (
        <div className="text-muted-foreground mt-0.5 font-mono text-[10.5px]">
          {t('conn_tool_args')}: {args}
        </div>
      )}

      {state === 'changed' && (
        <div className="border-hold/40 bg-hold/5 mt-1.5 rounded-lg border p-2 text-[11.5px]" data-drift>
          <p className="font-medium">{t('conn_tool_changedNote')}</p>
          {tool.previous?.description !== undefined && tool.previous.description !== (tool.description ?? '') && (
            <p className="text-muted-foreground mt-1 whitespace-pre-wrap break-words">
              <span className="font-medium">{t('conn_tool_before')}</span> {tool.previous.description || '—'}
            </p>
          )}
          {schemaChanged && <p className="text-muted-foreground mt-1">{t('conn_tool_argsChanged')}</p>}
        </div>
      )}

      {state !== 'missing' && (
        <div
          role="radiogroup"
          aria-label={t('conn_tool_policyLabel', [tool.tool])}
          className="bg-muted/60 mt-2 inline-flex flex-wrap gap-0.5 rounded-full p-0.5">
          {POLICIES.map(option => (
            <button
              key={option.value}
              type="button"
              role="radio"
              data-policy={option.value}
              aria-checked={chosen === option.value}
              disabled={busy}
              onClick={() => void choose(option.value)}
              className={cn(
                'rounded-full px-2.5 py-0.5 text-[11.5px] transition-colors disabled:opacity-50',
                chosen === option.value
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}>
              {t(option.label)}
            </button>
          ))}
        </div>
      )}
      {state === 'ok' && chosen === 'approve' && (
        <p className="text-muted-foreground mt-1 text-[11px]">{t('conn_policy_approveHint')}</p>
      )}
      {confirmRead && (
        <div role="alert" className="border-hold/40 mt-2 rounded-lg border p-2 text-[12px]">
          <p>{t('conn_policy_readConfirm')}</p>
          <div className="mt-1.5 flex gap-2">
            <Button size="sm" variant="glass" onClick={() => setConfirmRead(false)}>
              {t('conn_cancel')}
            </Button>
            <Button size="sm" variant="hold" data-confirm-read onClick={() => void choose('read')}>
              {t('conn_policy_readAnyway')}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
