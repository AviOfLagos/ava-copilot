import { Ear, EarOff } from 'lucide-react';
import { t } from '@extension/i18n';
import { ambientSettingsStore } from '@extension/storage';
import { openSettingsPage } from '@src/shared/lib/settings-page';
import { useStoreSettings } from '../settings/sections/ui';

// Settings › Voice › Ambient
export const AMBIENT_HASH = '#voice/ambient';

/**
 * The header's sign that Ava is listening (docs/ambient-plan.md: listening is always visible): an ear while she
 * writes down what is said, a crossed-out ear off the record, nothing when ambient listening is off. It opens
 * Settings › Ambient.
 */
export default function AmbientIndicator() {
  const settings = useStoreSettings(ambientSettingsStore);
  if (!settings || settings.mode === 'off') return null;
  const label = settings.offRecord ? t('ambient_indicator_offRecord') : t('ambient_indicator_listening');
  const Icon = settings.offRecord ? EarOff : Ear;
  return (
    <button
      type="button"
      data-testid="ambient-indicator"
      data-state={settings.offRecord ? 'off-record' : settings.mode}
      onClick={() => void openSettingsPage(AMBIENT_HASH)}
      aria-label={label}
      title={label}
      className="text-muted-foreground hover:bg-accent hover:text-foreground relative flex size-8 items-center justify-center rounded-[10px] transition-colors">
      <Icon className="size-4" aria-hidden="true" />
      {!settings.offRecord && (
        <span aria-hidden="true" className="bg-primary absolute right-1 top-1 size-1.5 animate-pulse rounded-full" />
      )}
    </button>
  );
}
