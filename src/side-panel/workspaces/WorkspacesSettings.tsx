import { useState } from 'react';
import { ChevronRight, Plus, Trash2 } from 'lucide-react';
import { t } from '@extension/i18n';
import { ACCOUNT_PLATFORMS, workspaceId, workspaceStore } from '@extension/storage';
import type { AccountPlatform, Workspace } from '@extension/storage';
import { Button } from '../components/ui/button';
import { useWorkspaces } from './WorkspacePicker';

const PLATFORM_LABELS: Record<AccountPlatform, { label: string; placeholder: string }> = {
  google: { label: 'Google', placeholder: 'you@company.com' },
  x: { label: 'X', placeholder: '@handle' },
  linkedin: { label: 'LinkedIn', placeholder: 'Your name, or the company page' },
  youtube: { label: 'YouTube', placeholder: 'Channel name' },
  instagram: { label: 'Instagram', placeholder: '@handle' },
  slack: { label: 'Slack', placeholder: 'workspace.slack.com' },
  github: { label: 'GitHub', placeholder: 'account or org' },
};

const field =
  'glass w-full rounded-xl px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50';

/** One workspace being edited: its name, what it is, the words that mean it, and its accounts. */
function Editor({ initial, taken, onDone }: { initial: Workspace; taken: string[]; onDone: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [keywords, setKeywords] = useState(initial.keywords.join(', '));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isNew = !initial.name;

  const save = async () => {
    if (!draft.name.trim()) return;
    const id = isNew ? workspaceId(draft.name, taken) : draft.id;
    await workspaceStore.save({ ...draft, id, keywords: keywords.split(',') });
    onDone();
  };

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      <label className="flex flex-col gap-1 text-[12px]">
        <span className="text-muted-foreground">{t('workspace_name')}</span>
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={isNew}
          value={draft.name}
          onChange={event => setDraft({ ...draft, name: event.target.value })}
          className={field}
        />
      </label>
      <label className="flex flex-col gap-1 text-[12px]">
        <span className="text-muted-foreground">{t('workspace_about')}</span>
        <textarea
          rows={3}
          value={draft.about}
          onChange={event => setDraft({ ...draft, about: event.target.value })}
          className={field}
        />
      </label>
      <label className="flex flex-col gap-1 text-[12px]">
        <span className="text-muted-foreground">{t('workspace_keywords')}</span>
        <input value={keywords} onChange={event => setKeywords(event.target.value)} className={field} />
      </label>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-muted-foreground mb-1 text-[12px]">{t('workspace_accounts')}</legend>
        {ACCOUNT_PLATFORMS.map(platform => (
          <label key={platform} className="grid grid-cols-[72px_1fr] items-center gap-2 text-[12px]">
            <span>{PLATFORM_LABELS[platform].label}</span>
            <input
              value={draft.accounts[platform] ?? ''}
              placeholder={PLATFORM_LABELS[platform].placeholder}
              onChange={event =>
                setDraft({ ...draft, accounts: { ...draft.accounts, [platform]: event.target.value } })
              }
              className={field}
            />
          </label>
        ))}
      </fieldset>
      <div className="mt-1 flex items-center gap-2">
        {!isNew &&
          (confirmDelete ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={async () => {
                await workspaceStore.remove(draft.id);
                onDone();
              }}>
              {t('workspace_delete')}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)} aria-label={t('workspace_delete')}>
              <Trash2 className="size-3.5" />
            </Button>
          ))}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onDone}>
          {t('workspace_cancel')}
        </Button>
        <Button size="sm" disabled={!draft.name.trim()} onClick={() => void save()}>
          {t('workspace_save')}
        </Button>
      </div>
    </div>
  );
}

/** The workspaces in settings: each opens to edit, and new ones are added at the end. */
export default function WorkspacesSettings() {
  const workspaces = useWorkspaces();
  const [editing, setEditing] = useState<Workspace | null>(null);

  if (editing) {
    return <Editor initial={editing} taken={workspaces.map(item => item.id)} onDone={() => setEditing(null)} />;
  }

  return (
    <>
      {workspaces.map(workspace => {
        const accounts = Object.values(workspace.accounts).filter(value => value?.trim()).length;
        return (
          <button
            key={workspace.id}
            type="button"
            onClick={() => setEditing(workspace)}
            className="hover:bg-accent/50 flex w-full items-center gap-3 px-3 py-2.5 text-left">
            <span className="min-w-0 flex-1">
              <span className="block text-[13px]">{workspace.name}</span>
              <span className="text-muted-foreground block truncate text-[11.5px]">
                {[workspace.about.split('\n')[0], accounts ? `${accounts} accounts` : ''].filter(Boolean).join(' · ') ||
                  workspace.keywords.join(', ')}
              </span>
            </span>
            <ChevronRight className="text-muted-foreground size-4" />
          </button>
        );
      })}
      <button
        type="button"
        onClick={() =>
          setEditing({
            id: workspaceId(
              'workspace',
              workspaces.map(item => item.id),
            ),
            name: '',
            about: '',
            keywords: [],
            accounts: {},
            createdAt: Date.now(),
          })
        }
        className="text-primary hover:bg-accent/50 flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px]">
        <Plus className="size-4" />
        {t('workspace_add')}
      </button>
    </>
  );
}
