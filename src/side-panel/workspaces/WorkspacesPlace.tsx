import { t } from '@extension/i18n';
import WorkspacesSettings from './WorkspacesSettings';

/**
 * Workspaces as their own place (reached from the profile menu): the same list, add and edit as
 * Settings used to show inline, plus what the star on each row means. `src/storage/lib/workspaces`
 * holds the one-time migration that gives every install a default once this ships. It needs
 * nothing from `PanelApi`, so the registry's `{ api }` prop is left out of the signature below —
 * a component that ignores its props is still assignable to `ComponentType<{ api: PanelApi }>`.
 */
export default function WorkspacesPlace() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-4 pt-3">
      <p className="text-muted-foreground px-1 text-[12px]">{t('shell_workspaces_hint')}</p>
      <section aria-label={t('settings_workspaces')}>
        <div className="glass divide-border/60 divide-y overflow-hidden rounded-2xl">
          <WorkspacesSettings />
        </div>
      </section>
    </div>
  );
}
