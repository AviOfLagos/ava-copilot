import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { briefSettingsStore } from '@extension/storage';
import type { BriefSettingsConfig } from '@extension/storage';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';

/** Settings › Morning brief: on or off, its time, and one made now. */
export default function BriefSettings({ onOpen }: { onOpen: (threadId: string) => void }) {
  const [settings, setSettings] = useState<BriefSettingsConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = () => void briefSettingsStore.getSettings().then(setSettings);
    load();
    return briefSettingsStore.subscribe(load);
  }, []);
  if (!settings) return null;

  const time = `${String(settings.hour).padStart(2, '0')}:${String(settings.minute).padStart(2, '0')}`;
  const row = 'flex items-center gap-3 px-3 py-2.5';
  return (
    <>
      <div className={row}>
        <div className="min-w-0 flex-1">
          <div className="text-[13px]">{t('settings_brief_on')}</div>
          <div className="text-muted-foreground mt-0.5 text-[11.5px]">{error || t('settings_brief_hint')}</div>
        </div>
        <Switch
          label={t('settings_brief_on')}
          checked={settings.enabled}
          onChange={enabled => void briefSettingsStore.updateSettings({ enabled })}
        />
      </div>
      <div className={row}>
        <label htmlFor="brief-time" className="flex-1 text-[13px]">
          {t('settings_brief_time')}
        </label>
        <input
          id="brief-time"
          type="time"
          value={time}
          onChange={event => {
            const [hour, minute] = event.target.value.split(':').map(Number);
            if (Number.isFinite(hour) && Number.isFinite(minute))
              void briefSettingsStore.updateSettings({ hour, minute });
          }}
          className="glass rounded-lg px-2 py-1 text-[13px] text-foreground outline-none"
        />
        <Button
          size="sm"
          variant="glass"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            const result = (await chrome.runtime.sendMessage({ type: 'brief_make' }).catch(() => null)) as {
              threadId?: string;
              error?: string;
            } | null;
            setBusy(false);
            if (result?.threadId) onOpen(result.threadId);
            else setError(result?.error ?? t('settings_brief_hint'));
          }}>
          {t('settings_brief_now')}
        </Button>
      </div>
    </>
  );
}
