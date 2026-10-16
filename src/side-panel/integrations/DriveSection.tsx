import { useEffect, useId, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { t } from '@extension/i18n';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { inputClass, Section } from '../models/ui';
import type { PanelApi } from '../registry';
import { useDefaultWorkspaceId, useWorkspaces } from '../workspaces/WorkspacePicker';

type MessageKey = Parameters<typeof t>[0];

type Reply =
  | { status: 'saved'; title: string; refreshed: boolean }
  | { status: 'signin' }
  | { status: 'problem'; problem: string };

const PROBLEM_TEXT: Record<string, MessageKey> = {
  not_a_link: 'drive_add_notLink',
  folder: 'drive_add_folder',
  no_access: 'drive_add_noAccess',
  unreadable: 'drive_add_unreadable',
  empty: 'drive_add_empty',
  blocked: 'drive_add_blocked',
};

/**
 * Google Drive in Connectors: it works through the browser the user is already signed in to, with nothing to
 * set up. "Add from Drive" keeps a pasted file in a workspace's knowledge base; the MCP server stays in the
 * catalogue below as the advanced way.
 */
export function DriveSection({ api }: { api: PanelApi }) {
  const workspaces = useWorkspaces();
  const defaultId = useDefaultWorkspaceId();
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: 'ok' | 'hold' | 'error' } | null>(null);
  const linkId = useId();
  const workspaceFieldId = useId();

  useEffect(() => {
    if (!workspaceId && defaultId) setWorkspaceId(defaultId);
  }, [defaultId, workspaceId]);

  const add = async () => {
    if (!link.trim() || busy) return;
    setBusy(true);
    setNote({ text: t('drive_add_working'), tone: 'ok' });
    try {
      const reply = await api.request<Reply>(
        { type: 'drive_add_link', link: link.trim(), workspaceId: workspaceId || null },
        120_000,
      );
      if (reply.status === 'saved') {
        setNote({ text: t(reply.refreshed ? 'drive_add_refreshed' : 'drive_add_saved', [reply.title]), tone: 'ok' });
        setLink('');
      } else if (reply.status === 'signin') {
        setNote({ text: t('drive_add_signIn'), tone: 'hold' });
      } else {
        setNote({ text: t(PROBLEM_TEXT[reply.problem] ?? 'drive_add_failed'), tone: 'error' });
      }
    } catch {
      setNote({ text: t('drive_add_failed'), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section label={t('drive_section_title')}>
      <div className="flex flex-col gap-2 px-3 py-2.5" data-drive-section>
        <div className="flex items-start gap-2.5">
          <HardDrive className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="text-[13px] font-medium">{t('drive_name')}</span>
              <Badge variant="outline">{t('drive_badge_noSetup')}</Badge>
            </span>
            <span className="text-muted-foreground mt-0.5 block text-[11.5px]">{t('drive_section_how')}</span>
          </span>
        </div>
        <label htmlFor={linkId} className="text-muted-foreground block text-[11px]">
          {t('drive_add_label')}
        </label>
        <div className="flex gap-1.5">
          <input
            id={linkId}
            type="url"
            inputMode="url"
            value={link}
            placeholder="https://docs.google.com/document/d/…"
            onChange={event => setLink(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void add();
            }}
            className={inputClass}
            data-drive-link
          />
          <Button size="sm" onClick={() => void add()} disabled={busy || !link.trim()} data-drive-add>
            {t('drive_add_button')}
          </Button>
        </div>
        {workspaces.length > 0 && (
          <div className="flex items-center gap-2">
            <label htmlFor={workspaceFieldId} className="text-muted-foreground text-[11px]">
              {t('drive_add_workspace')}
            </label>
            <select
              id={workspaceFieldId}
              value={workspaceId}
              onChange={event => setWorkspaceId(event.target.value)}
              className="border-input bg-background rounded-md border px-1.5 py-0.5 text-[12px]">
              <option value="">{t('drive_add_noWorkspace')}</option>
              {workspaces.map(workspace => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {note && (
          <p
            role="status"
            data-drive-note={note.tone}
            className={
              note.tone === 'error'
                ? 'text-destructive text-[12px]'
                : note.tone === 'hold'
                  ? 'text-hold-foreground text-[12px]'
                  : 'text-muted-foreground text-[12px]'
            }>
            {note.text}
          </p>
        )}
      </div>
    </Section>
  );
}
