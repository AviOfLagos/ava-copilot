import { useState } from 'react';
import { ChevronRight, Laptop, Plus, Sparkles } from 'lucide-react';
import { t } from '@extension/i18n';
import { CONNECTOR_CATALOG, connectorToolState, db } from '@extension/storage';
import type { ConnectorCatalogId, ConnectorRecord, ToolFingerprint } from '@extension/storage';
import { cn } from '@extension/ui';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { useLive } from '../hooks/useLive';
import { Section } from '../models/ui';
import type { PanelApi } from '../registry';
import AddConnector from './AddConnector';
import VaultSettings from '../vault/VaultSettings';
import ConnectorDetail from './ConnectorDetail';
import { DriveSection } from './DriveSection';
import { CATALOG_HOW, hostOf, STATUS_LABEL, statusTone } from './meta';
import { SetupGuide } from './SetupGuide';
import type { SetupTarget } from './SetupGuide';

type View =
  | { kind: 'list' }
  | { kind: 'detail'; id: string; signIn?: boolean }
  | { kind: 'add'; catalogId: ConnectorCatalogId | null };

/** "Set it up with Ava" next to a connection: the guide opens at the top of the list. */
function AvaButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={t('conn_setup_withAvaNamed', [name])}
      title={t('conn_setup_withAva')}
      onClick={onClick}
      data-setup-start={name}>
      <Sparkles className="size-3.5" aria-hidden />
      {t('conn_setup_withAvaShort')}
    </Button>
  );
}

function ConnectorRow({
  connector,
  tools,
  onOpen,
}: {
  connector: ConnectorRecord;
  tools: ToolFingerprint[];
  onOpen: () => void;
}) {
  const listed = tools.filter(tool => !tool.missing);
  const waiting = listed.filter(tool => connectorToolState(tool) !== 'ok').length;
  const parts = [
    t(STATUS_LABEL[connector.status]),
    t('conn_row_tools', [String(listed.length)]),
    connector.workspaceIds.length ? null : t('conn_row_noWorkspace'),
  ].filter(Boolean);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-connector-row={connector.name}
        className="hover:bg-accent flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors">
        <span className={cn('mt-[7px] size-2 shrink-0 rounded-full', statusTone(connector.status))} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium">{connector.name}</span>
            {waiting > 0 && <Badge variant="hold">{t('conn_row_review', [String(waiting)])}</Badge>}
          </span>
          <span className="text-muted-foreground mt-0.5 block truncate text-[11.5px]">
            {hostOf(connector.url)} · {parts.join(' · ')}
          </span>
        </span>
        <ChevronRight className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
      </button>
    </li>
  );
}

function ConnectorList({
  api,
  onOpen,
  onAdd,
  guide,
  onGuide,
}: {
  api: PanelApi;
  onOpen: (id: string) => void;
  onAdd: (catalogId: ConnectorCatalogId | null) => void;
  guide: SetupTarget | null;
  onGuide: (target: SetupTarget | null) => void;
}) {
  const connectors = useLive(() => db.connectors.toArray(), [], [] as ConnectorRecord[]);
  const fingerprints = useLive(() => db.toolFingerprints.toArray(), [], [] as ToolFingerprint[]);
  const sorted = [...connectors].sort((a, b) => a.name.localeCompare(b.name));
  const added = new Set(connectors.map(connector => connector.catalogId).filter(Boolean));

  return (
    <>
      {guide && (
        <SetupGuide key={guide} api={api} target={guide} onClose={() => onGuide(null)} onOpenConnector={onOpen} />
      )}
      <Section
        label={t('conn_list_title')}
        action={
          <Button size="sm" onClick={() => onAdd(null)} data-add-connector>
            <Plus className="size-3.5" aria-hidden />
            {t('conn_list_add')}
          </Button>
        }>
        {sorted.length === 0 ? (
          <p className="text-muted-foreground p-3 text-[12.5px]">{t('conn_list_empty')}</p>
        ) : (
          <ul className="divide-border/60 divide-y">
            {sorted.map(connector => (
              <ConnectorRow
                key={connector.id}
                connector={connector}
                tools={fingerprints.filter(tool => tool.connectorId === connector.id)}
                onOpen={() => onOpen(connector.id)}
              />
            ))}
          </ul>
        )}
      </Section>

      <DriveSection api={api} />

      <Section label={t('conn_catalog_title')}>
        <ul className="divide-border/60 divide-y">
          {CONNECTOR_CATALOG.map(entry => (
            <li key={entry.id} className="flex items-center gap-2.5 px-3 py-2.5" data-catalog={entry.id}>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium">{entry.name}</span>
                <span className="text-muted-foreground block text-[11.5px]">{t(CATALOG_HOW[entry.id])}</span>
              </span>
              <AvaButton name={entry.name} onClick={() => onGuide(entry.id)} />
              <Button
                size="sm"
                variant="glass"
                aria-label={t('conn_catalog_addNamed', [entry.name])}
                onClick={() => onAdd(entry.id)}>
                {added.has(entry.id) ? t('conn_catalog_addAnother') : t('conn_catalog_add')}
              </Button>
            </li>
          ))}
          <li className="flex items-center gap-2.5 px-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">{t('conn_custom_title')}</span>
              <span className="text-muted-foreground block text-[11.5px]">{t('conn_custom_hint')}</span>
            </span>
            <AvaButton name={t('conn_custom_title')} onClick={() => onGuide('custom')} />
            <Button size="sm" variant="glass" onClick={() => onAdd(null)}>
              <Plus className="size-3.5" />
              {t('conn_custom_add')}
            </Button>
          </li>
        </ul>
      </Section>

      <Section
        label={t('conn_obsidian_title')}
        action={<AvaButton name="Obsidian" onClick={() => onGuide('obsidian')} />}>
        <div data-connections-obsidian>
          <VaultSettings />
        </div>
      </Section>

      <Section label={t('conn_mac_title')}>
        <div className="flex items-start gap-2.5 px-3 py-2.5 opacity-70" aria-disabled="true">
          <Laptop className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="text-[13px] font-medium">{t('conn_mac_name')}</span>
              <Badge variant="outline">{t('conn_mac_soon')}</Badge>
            </span>
            <span className="text-muted-foreground mt-0.5 block text-[11.5px]">{t('conn_mac_hint')}</span>
          </span>
        </div>
      </Section>
    </>
  );
}

/**
 * Connectors: tools from anywhere. Remote MCP servers the agent and routines may use, each bound to the
 * workspaces the user picks, with a choice per tool (off, ask first, run freely) and a warning when a tool
 * changes. Well-known servers are listed with how to sign in; any other is added by its address.
 */
export default function ConnectorsPlace({ api }: { api: PanelApi }) {
  const [view, setView] = useState<View>({ kind: 'list' });
  // The guided setup open at the top of the list, kept while the user looks at a connector and comes back
  const [guide, setGuide] = useState<SetupTarget | null>(null);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-4 pt-2" data-place="connectors">
      {view.kind === 'list' && (
        <ConnectorList
          api={api}
          onOpen={id => setView({ kind: 'detail', id })}
          onAdd={catalogId => setView({ kind: 'add', catalogId })}
          guide={guide}
          onGuide={setGuide}
        />
      )}
      {view.kind === 'add' && (
        <AddConnector
          api={api}
          catalogId={view.catalogId}
          onCancel={() => setView({ kind: 'list' })}
          onAdded={(id, signIn) => setView({ kind: 'detail', id, signIn })}
        />
      )}
      {view.kind === 'detail' && (
        <ConnectorDetail api={api} id={view.id} autoSignIn={view.signIn} onBack={() => setView({ kind: 'list' })} />
      )}
    </div>
  );
}
