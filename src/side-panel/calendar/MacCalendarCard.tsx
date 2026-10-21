import { useCallback, useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { brainSettingsStore } from '@src/background/companion/state';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { askBackground } from '../vault/brain';
import { byAccount, macCardState, toggleCalendar } from './macCalendar';
import type { MacStatusReply } from './macCalendar';

const hint = 'text-[11.5px] text-muted-foreground';

/**
 * Settings › Calendar, first part: the Mac's Calendar through Nex Brain, which reads every account macOS syncs
 * (Google Workspace included, where secret iCal addresses are often off). Shows macOS's permission state and the
 * steps, and which calendars count.
 */
export function MacCalendarCard({
  macEnabled,
  macCalendarIds,
  onChange,
}: {
  macEnabled: boolean;
  macCalendarIds: string[] | null;
  onChange: (changes: { macEnabled?: boolean; macCalendarIds?: string[] | null }) => void;
}) {
  const [reply, setReply] = useState<MacStatusReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const check = useCallback(() => {
    setError(null);
    setReply(null);
    askBackground<MacStatusReply>('calendar_mac_status').then(setReply, failure =>
      setError(failure instanceof Error ? failure.message : String(failure)),
    );
  }, []);

  useEffect(() => {
    check();
    // Pairing or unpairing Nex Brain changes which way the calendar is read
    return brainSettingsStore.subscribe(check);
  }, [check]);

  const allow = () => {
    setAsking(true);
    setError(null);
    askBackground<MacStatusReply>('calendar_mac_request')
      .then(setReply, failure => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setAsking(false));
  };

  const save = (changes: { macEnabled?: boolean; macCalendarIds?: string[] | null }) => {
    onChange(changes);
    void askBackground('calendar_mac_settings', changes).catch(() => {});
  };

  const state = macCardState({ reply, error });
  const checkAgain = (
    <Button size="sm" variant="glass" onClick={check}>
      {t('settings_calendar_mac_check')}
    </Button>
  );

  return (
    <div className="space-y-2 p-3" data-calendar-mac={state}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px]">{t('settings_calendar_mac_title')}</div>
          <div className={hint}>{t('settings_calendar_mac_hint')}</div>
        </div>
        {state === 'ready' && (
          <Switch
            label={t('settings_calendar_mac_title')}
            checked={macEnabled}
            onChange={value => save({ macEnabled: value })}
          />
        )}
      </div>

      {state === 'unpaired' && <p className={hint}>{t('settings_calendar_mac_unpaired')}</p>}
      {state === 'loading' && <p className={hint}>{t('settings_calendar_mac_checking')}</p>}
      {state === 'offline' && (
        <div className="space-y-1.5">
          <p role="alert" className="text-[11.5px] text-destructive">
            {error}
          </p>
          {checkAgain}
        </div>
      )}
      {(state === 'needs_permission' || state === 'denied') && (
        <div className="space-y-1.5" data-calendar-mac-steps>
          {reply?.message && <p className="text-[11.5px]">{reply.message}</p>}
          <ol className="list-decimal space-y-0.5 pl-4 text-[11.5px] text-muted-foreground">
            {state === 'needs_permission' && <li>{t('settings_calendar_mac_step_allow')}</li>}
            <li>{t('settings_calendar_mac_step_settings')}</li>
            <li>{t('settings_calendar_mac_step_check')}</li>
          </ol>
          <div className="flex gap-2">
            {state === 'needs_permission' && (
              <Button size="sm" variant="hold" disabled={asking} onClick={allow}>
                {asking ? t('settings_calendar_mac_asking') : t('settings_calendar_mac_allow')}
              </Button>
            )}
            {checkAgain}
          </div>
        </div>
      )}
      {state === 'unavailable' && <p className={hint}>{reply?.message ?? t('settings_calendar_mac_unavailable')}</p>}
      {state === 'ready' && macEnabled && (
        <div className="space-y-1.5">
          {(reply?.calendars ?? []).length === 0 ? (
            <p className={hint}>{t('settings_calendar_mac_noCalendars')}</p>
          ) : (
            byAccount(reply?.calendars ?? []).map(group => (
              <fieldset key={group.account} className="space-y-0.5">
                <legend className="text-[11.5px] font-medium">{group.account}</legend>
                {group.calendars.map(calendar => {
                  const all = (reply?.calendars ?? []).map(item => item.id);
                  const checked = macCalendarIds === null || macCalendarIds.includes(calendar.id);
                  return (
                    <label key={calendar.id} className="flex items-center gap-2 text-[12px]">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={event =>
                          save({
                            macCalendarIds: toggleCalendar(macCalendarIds, all, calendar.id, event.target.checked),
                          })
                        }
                      />
                      <span className="truncate">{calendar.title}</span>
                    </label>
                  );
                })}
              </fieldset>
            ))
          )}
          <p className={hint}>{t('settings_calendar_mac_accounts')}</p>
        </div>
      )}
    </div>
  );
}
