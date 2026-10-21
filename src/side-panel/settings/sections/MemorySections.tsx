import { useEffect, useRef, useState } from 'react';
import { t } from '@extension/i18n';
import { kbSettingsStore } from '@extension/storage';
import type { KbSettingsConfig } from '@extension/storage';
import { describeCounts, megabytes, RestoreConfirm, useRestore, when } from '../../backup/BackupList';
import { exportBackupFile, readPickedFile, stageRestoreFile } from '../../backup/file';
import type { PickedFile } from '../../backup/file';
import type { PanelApi } from '../../registry';
import { Button } from '../../components/ui/button';
import { Switch } from '../../components/ui/switch';
import { useAgents } from '../../kb/AgentPicker';
import { AgentMemory } from '../../kb/MemoryScope';
import { embedRequirement } from '../../requirements/catalog';
import { RequirementCard, installSuffix, useRequirementFlow } from '../../requirements/RequirementCard';
import { HINT, Row, SELECT, useStoreSettings } from './ui';

const RETENTION_DAYS = [0, 30, 90, 180, 365];

/** The background owns the knowledge base and its search index; settings ask it. */
async function kbRequest(message: Record<string, unknown>): Promise<{ ok: boolean; count?: number; error?: string }> {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error || t('errors_unknown'));
  return reply;
}

const update = async (changes: Partial<KbSettingsConfig>) => {
  await kbSettingsStore.updateSettings(changes);
  // Retention and newly added sources apply right away
  await kbRequest({ type: 'kb_sweep' }).catch(() => {});
};

/**
 * What joins memory on its own, how it searches by meaning, and how long it keeps things. Local search needs
 * Ollama with the embedding model: choosing it offers the pull first, and keeps the old choice until it is there.
 */
export function MemoryIndexSection() {
  const settings = useStoreSettings(kbSettingsStore);
  const { flow, state } = useRequirementFlow();
  const [localReady, setLocalReady] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    void embedRequirement()
      .then(requirement => requirement.isReady())
      .then(ready => alive && setLocalReady(ready))
      .catch(() => alive && setLocalReady(false));
    return () => {
      alive = false;
    };
  }, [state.phase]);

  if (!settings) return null;
  const toggle = (key: 'indexChats' | 'indexMeetings' | 'buildGraph', label: string, hint?: string) => (
    <Row title={label} hint={hint}>
      <Switch label={label} checked={settings[key]} onChange={value => void update({ [key]: value })} />
    </Row>
  );

  const chooseEmbed = async (source: KbSettingsConfig['embedSource']) => {
    if (source !== 'local') {
      flow.cancel();
      await update({ embedSource: source });
      return;
    }
    await flow.choose(await embedRequirement(), () => update({ embedSource: 'local' }));
  };

  return (
    <>
      {toggle('indexChats', t('options_kb_indexChats'), t('options_kb_indexChats_desc'))}
      {toggle('indexMeetings', t('options_kb_indexMeetings'), t('options_kb_indexMeetings_desc'))}
      {toggle('buildGraph', t('options_kb_buildGraph'), t('options_kb_buildGraph_hint'))}
      <Row
        title={t('settings_embed')}
        hint={
          settings.embedSource === 'local' && localReady === false ? (
            <span className="text-destructive" data-testid="embed-missing">
              {t('requirement_embed_missing', [settings.localEmbedModel || 'nomic-embed-text'])}
            </span>
          ) : (
            t('settings_embed_hint')
          )
        }
        htmlFor="settings-embed">
        <select
          id="settings-embed"
          value={settings.embedSource}
          onChange={event => void chooseEmbed(event.target.value as KbSettingsConfig['embedSource'])}
          className={SELECT}>
          <option value="auto">{t('settings_embed_auto')}</option>
          <option value="gemini">Gemini</option>
          <option value="local">
            {t('settings_embed_local')}
            {localReady === false ? installSuffix(274e6) : ''}
          </option>
        </select>
      </Row>
      <RequirementCard flow={flow} state={state} />
      {settings.embedSource === 'local' && localReady === false && state.phase === 'idle' && (
        <div className="flex justify-end px-3 pb-2.5">
          <Button size="sm" variant="glass" onClick={() => void chooseEmbed('local')}>
            {t('requirement_install')}
          </Button>
        </div>
      )}
      <Row title={t('options_kb_retention')} hint={t('options_kb_retention_desc')} htmlFor="settings-retention">
        <select
          id="settings-retention"
          value={settings.retentionDays}
          onChange={event => void update({ retentionDays: Number(event.target.value) })}
          className={SELECT}>
          {RETENTION_DAYS.map(days => (
            <option key={days} value={days}>
              {days === 0 ? t('options_kb_retention_forever') : t('options_kb_retention_days', [String(days)])}
            </option>
          ))}
        </select>
      </Row>
    </>
  );
}

/**
 * Export everything as a backup file (the same snapshot Nex Brain keeps, without API keys), bring one back (or an
 * older knowledge-only export, merged as before), or wipe the knowledge base.
 */
export function MemoryDataSection({ api }: { api: PanelApi }) {
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [picked, setPicked] = useState<Extract<PickedFile, { kind: 'snapshot' }> | null>(null);
  const restoreFile = useRestore(api.request);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async (work: () => Promise<string>) => {
    setStatus(null);
    try {
      setStatus({ text: await work(), error: false });
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : String(error), error: true });
    }
  };

  const exportAll = () => run(async () => t('backup_exported', [megabytes(await exportBackupFile())]));

  const importFile = (file: File) =>
    run(async () => {
      setPicked(null);
      const read = await readPickedFile(file);
      if (read.kind === 'snapshot') {
        setPicked(read);
        return t('backup_file_ready');
      }
      const { count = 0 } = await kbRequest({ type: 'kb_import', data: read.data });
      return t('options_kb_imported', [String(count)]);
    });

  const restorePicked = async () => {
    if (!picked) return;
    await stageRestoreFile(picked.bytes);
    await restoreFile.restore({ type: 'backup_restore_file', confirmed: true });
  };

  const wipe = () => {
    if (!window.confirm(t('options_kb_wipeConfirm'))) return;
    void run(async () => {
      await kbRequest({ type: 'kb_wipe' });
      return t('options_kb_wiped');
    });
  };

  return (
    <div className="space-y-2 p-3">
      <p className={HINT}>{t('options_kb_desc')}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="glass" onClick={() => void exportAll()}>
          {t('backup_export')}
        </Button>
        <Button size="sm" variant="glass" onClick={() => fileRef.current?.click()}>
          {t('backup_import')}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,application/gzip,.json,.gz"
          className="hidden"
          aria-label={t('backup_import')}
          onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void importFile(file);
          }}
        />
        <Button size="sm" variant="destructive" onClick={wipe}>
          {t('options_kb_wipe')}
        </Button>
      </div>
      {picked && !restoreFile.done && (
        <RestoreConfirm
          question={t('backup_file_confirm', [when(picked.snapshot.createdAt), describeCounts(picked.snapshot.counts)])}
          busy={restoreFile.busy}
          onCancel={() => setPicked(null)}
          onConfirm={() => void restorePicked()}
        />
      )}
      {restoreFile.done && (
        <p role="status" className="text-[12.5px]">
          {t('backup_restored')}
        </p>
      )}
      {restoreFile.error && (
        <p role="alert" className="text-destructive text-[11.5px]">
          {restoreFile.error}
        </p>
      )}
      {status && !picked && (
        <p
          role={status.error ? 'alert' : 'status'}
          className={status.error ? 'text-destructive text-[11.5px]' : 'text-muted-foreground text-[11.5px]'}>
          {status.text}
        </p>
      )}
    </div>
  );
}

/** Each agent's private memory and the team's: pick an agent, move items between them, or delete. */
export function AgentMemorySection() {
  const agents = useAgents(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const chosen = agents.find(agent => agent.id === agentId) ?? agents[0];
  if (!chosen) return <p className={`${HINT} p-3`}>{t('settings_memory_noAgents')}</p>;
  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center gap-2">
        <label htmlFor="settings-memory-agent" className="min-w-0 flex-1 text-[13px]">
          {t('settings_memory_agent')}
        </label>
        <select
          id="settings-memory-agent"
          value={chosen.id}
          onChange={event => setAgentId(event.target.value)}
          className={SELECT}>
          {agents.map(agent => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </div>
      <AgentMemory agentId={chosen.id} />
    </div>
  );
}
