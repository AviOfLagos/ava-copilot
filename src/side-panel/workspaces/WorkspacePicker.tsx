import { useEffect, useState } from 'react';
import { Layers } from 'lucide-react';
import { t } from '@extension/i18n';
import { workspaceStore } from '@extension/storage';
import type { Workspace } from '@extension/storage';
import { cn } from '@extension/ui';

/** The user's workspaces, kept current as settings change them. */
export function useWorkspaces(): Workspace[] {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  useEffect(() => {
    const load = () => void workspaceStore.list().then(setWorkspaces);
    load();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.workspaces) load();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);
  return workspaces;
}

/** The workspace new chats, background runs and routing fall back to; null means none chosen. */
export function useDefaultWorkspaceId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    const load = () => void workspaceStore.getDefaultWorkspaceId().then(setId);
    load();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.workspaces) load();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);
  return id;
}

interface WorkspacePickerProps {
  value: string | null;
  onChange: (workspaceId: string | null) => void;
  // What no workspace means here: "Auto" before a chat starts, "No workspace" in one
  emptyLabel: string;
  disabled?: boolean;
  className?: string;
}

/** A chip that shows a chat's workspace and changes it. */
export default function WorkspacePicker({ value, onChange, emptyLabel, disabled, className }: WorkspacePickerProps) {
  const workspaces = useWorkspaces();
  return (
    <label
      className={cn(
        'flex h-6 min-w-0 items-center gap-1.5 rounded-full border bg-card px-2 text-[11px]',
        value && 'border-primary/40',
        className,
      )}>
      <Layers className={cn('size-3 shrink-0', value ? 'text-primary' : 'text-muted-foreground')} />
      <span className="sr-only">{t('workspace_label')}</span>
      <select
        value={value ?? ''}
        disabled={disabled}
        onChange={event => onChange(event.target.value || null)}
        className="text-foreground min-w-0 flex-1 cursor-pointer appearance-none truncate bg-transparent text-[11px] outline-none disabled:cursor-default">
        <option value="">{emptyLabel}</option>
        {workspaces.map(workspace => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}
          </option>
        ))}
      </select>
    </label>
  );
}
