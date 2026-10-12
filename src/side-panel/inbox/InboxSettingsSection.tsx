import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { DEFAULT_INBOX_SETTINGS, inboxSettingsStore } from '@extension/storage';
import type { InboxSettingsConfig } from '@extension/storage';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import type { PanelApi } from '../registry';

/**
 * The settings, kept current as they change elsewhere. A manual subscribe rather than the generic
 * `useStorage` hook (which suspends on first read): no Suspense boundary wraps settings sections here.
 */
function useInboxSettings(): InboxSettingsConfig {
  const [settings, setSettings] = useState<InboxSettingsConfig>(DEFAULT_INBOX_SETTINGS);
  useEffect(() => {
    let live = true;
    const load = () => void inboxSettingsStore.getSettings().then(value => live && setSettings(value));
    load();
    const unsubscribe = inboxSettingsStore.subscribe(load);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return settings;
}

type MessageKey = Parameters<typeof t>[0];
type WatcherKey = 'watchWhatsapp' | 'watchSlack' | 'watchGmail';
const WATCHERS: { key: WatcherKey; label: MessageKey; hint: string }[] = [
  { key: 'watchWhatsapp', label: 'inbox_settings_watchWhatsapp', hint: 'web.whatsapp.com' },
  { key: 'watchSlack', label: 'inbox_settings_watchSlack', hint: '*.slack.com' },
  { key: 'watchGmail', label: 'inbox_settings_watchGmail', hint: 'mail.google.com' },
];

function TimeField({
  value,
  onChange,
  label,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[12px]">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="time"
        value={value ?? ''}
        onChange={event => onChange(event.target.value || null)}
        className="bg-secondary rounded-md px-1.5 py-0.5 text-[12px]"
      />
    </label>
  );
}

/** "Speak up when something needs me", quiet hours, and which open tabs the Inbox may read from. */
export default function InboxSettingsSection({ api }: { api: PanelApi }) {
  const settings = useInboxSettings();
  const [checking, setChecking] = useState<WatcherKey | null>(null);
  const [checkResult, setCheckResult] = useState<string | null>(null);

  const update = (changes: Partial<InboxSettingsConfig>) => void inboxSettingsStore.updateSettings(changes);

  const checkNow = async (key: WatcherKey) => {
    setChecking(key);
    setCheckResult(null);
    try {
      const reply = await api.request<{ added: number }>({ type: 'inbox_watch_now' });
      setCheckResult(t('inbox_settings_checkNow_result', [String(reply.added)]));
    } catch (problem) {
      setCheckResult(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setChecking(null);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[13px] font-medium">{t('inbox_settings_speakUp_label')}</p>
          <p className="text-muted-foreground text-[11.5px]">{t('inbox_settings_speakUp_hint')}</p>
        </div>
        <Switch
          checked={settings.speakUp}
          onChange={checked => update({ speakUp: checked })}
          label={t('inbox_settings_speakUp_label')}
        />
      </div>

      <div>
        <p className="text-[13px] font-medium">{t('inbox_settings_quietHours_label')}</p>
        <p className="text-muted-foreground mb-1.5 text-[11.5px]">{t('inbox_settings_quietHours_hint')}</p>
        <div className="flex items-center gap-3">
          <TimeField
            label={t('inbox_settings_quietHours_start')}
            value={settings.quietHoursStart}
            onChange={value => update({ quietHoursStart: value })}
          />
          <TimeField
            label={t('inbox_settings_quietHours_end')}
            value={settings.quietHoursEnd}
            onChange={value => update({ quietHoursEnd: value })}
          />
          {(settings.quietHoursStart || settings.quietHoursEnd) && (
            <Button size="sm" variant="ghost" onClick={() => update({ quietHoursStart: null, quietHoursEnd: null })}>
              {t('inbox_settings_quietHours_off')}
            </Button>
          )}
        </div>
      </div>

      <div>
        <p className="text-[13px] font-medium">{t('inbox_settings_watchers_label')}</p>
        <p className="text-muted-foreground mb-1.5 text-[11.5px]">{t('inbox_settings_watchers_hint')}</p>
        <ul className="flex flex-col gap-2">
          {WATCHERS.map(watcher => (
            <li key={watcher.key} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[12.5px]">{t(watcher.label)}</p>
                <p className="text-muted-foreground truncate text-[11px]">{watcher.hint}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {settings[watcher.key] && (
                  <Button
                    size="sm"
                    variant="glass"
                    disabled={checking !== null}
                    onClick={() => void checkNow(watcher.key)}>
                    {checking === watcher.key ? t('inbox_settings_checkNow_busy') : t('inbox_settings_checkNow')}
                  </Button>
                )}
                <Switch
                  checked={settings[watcher.key]}
                  onChange={checked => update({ [watcher.key]: checked } as Partial<InboxSettingsConfig>)}
                  label={t(watcher.label)}
                />
              </div>
            </li>
          ))}
        </ul>
        {checkResult && <p className="text-muted-foreground mt-1.5 text-[11.5px]">{checkResult}</p>}
      </div>
    </section>
  );
}
