import { Check } from 'lucide-react';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import { useWorkspaces } from '../workspaces/WorkspacePicker';

/** The workspaces a connector serves, as chips to tick. None ticked means no chat can use it yet. */
export function WorkspaceChecks({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const workspaces = useWorkspaces();
  if (!workspaces.length) return <p className="text-muted-foreground text-[12px]">{t('conn_workspacesNone')}</p>;
  return (
    <div role="group" aria-label={t('conn_workspaces')} className="flex flex-wrap gap-1.5">
      {workspaces.map(workspace => {
        const checked = value.includes(workspace.id);
        return (
          <button
            key={workspace.id}
            type="button"
            role="checkbox"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(checked ? value.filter(id => id !== workspace.id) : [...value, workspace.id])}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] transition-colors disabled:opacity-50',
              checked
                ? 'border-primary/60 bg-primary/15 text-foreground'
                : 'border-input text-muted-foreground hover:text-foreground',
            )}>
            {checked && <Check className="size-3" aria-hidden />}
            {workspace.name}
          </button>
        );
      })}
    </div>
  );
}
