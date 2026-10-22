import { ListChecks } from 'lucide-react';
import { t } from '@extension/i18n';
import { openSettingsPage } from '@src/shared/lib/settings-page';
import { useSetupState } from './useSetupState';

// Where the checklist lives: Settings › General › Setup
export const SETUP_HASH = '#general/setup';

/**
 * The header's reminder that setup is not finished: a small count while a required step, or a recommended one the
 * user has not skipped, is not ready. It opens the checklist, and goes away once everything is done or skipped.
 */
export default function SetupIndicator() {
  const state = useSetupState();
  const pending = state?.pending ?? 0;
  if (!pending) return null;
  const label = t('setup_indicator', [String(pending)]);
  return (
    <button
      type="button"
      data-testid="setup-indicator"
      data-pending={pending}
      onClick={() => void openSettingsPage(SETUP_HASH)}
      aria-label={label}
      title={label}
      className="text-muted-foreground hover:bg-accent hover:text-foreground relative flex size-8 items-center justify-center rounded-[10px] transition-colors">
      <ListChecks className="size-4" aria-hidden="true" />
      <span
        aria-hidden="true"
        className="bg-primary text-background absolute right-0.5 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 font-mono text-[9px] font-semibold leading-none">
        {pending > 9 ? '9+' : pending}
      </span>
    </button>
  );
}
