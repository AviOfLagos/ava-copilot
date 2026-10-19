import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import { calendarSettingsStore, db, upcomingEventsStore } from '@extension/storage';
import { Button } from '../../components/ui/button';
import { useLive } from '../../hooks/useLive';
import type { PanelApi } from '../../registry';
import VaultSettings from '../../vault/VaultSettings';
import { Row, SELECT } from './ui';

/** Connectors live in the side panel, where signing in and their tools are; this says how many and opens it. */
export function ConnectorsSection({ api }: { api: PanelApi }) {
  const count = useLive(() => db.connectors.count(), [], 0);
  return (
    <Row title={t('conn_place')} hint={t('settings_connectors_hint', [String(count ?? 0)])}>
      <Button size="sm" variant="glass" onClick={() => api.go('connectors')}>
        {t('settings_connectors_open')}
        <ArrowUpRight className="size-3.5" aria-hidden />
      </Button>
    </Row>
  );
}

export function ObsidianSection() {
  return <VaultSettings />;
}

/** The calendar: a secret iCal address (or Google Calendar found for you), and reminders before meetings. */
export function CalendarSection() {
  const [calendar, setCalendar] = useState({ icsUrl: '', remindMinutes: 5, reminders: true });
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [connecting, setConnecting] = useState(false);
  // A calendar the connector found, waiting for the user to choose it
  const [found, setFound] = useState<{ calendar: string; url: string } | null>(null);

  useEffect(() => {
    void calendarSettingsStore.getSettings().then(setCalendar);
  }, []);

  const save = async (changes: Partial<typeof calendar>) => {
    const next = { ...calendar, ...changes };
    setCalendar(next);
    await calendarSettingsStore.updateSettings(changes);
    if (!('icsUrl' in changes)) return;
    setStatus(null);
    const reply = await chrome.runtime.sendMessage({ type: 'kb_calendar_refresh' }).catch(() => null);
    if (!next.icsUrl.trim()) return;
    if (!reply?.ok) {
      setStatus({ text: reply?.error ?? t('errors_unknown'), error: true });
      return;
    }
    const { events } = await upcomingEventsStore.get();
    setStatus({ text: t('settings_calendar_ok', [String(events.length)]), error: false });
  };

  const connect = () => {
    setConnecting(true);
    setStatus({ text: t('settings_calendar_connecting'), error: false });
    void chrome.runtime
      .sendMessage({ type: 'kb_calendar_connect' })
      .then((reply: { ok: boolean; error?: string; calendar?: string; url?: string } | undefined) => {
        if (!reply?.ok || !reply.url) {
          setStatus({ text: reply?.error ?? t('errors_unknown'), error: true });
          return;
        }
        setStatus(null);
        setFound({ calendar: reply.calendar ?? '', url: reply.url });
      })
      .finally(() => setConnecting(false));
  };

  return (
    <>
      <div className="space-y-2 p-3">
        <label htmlFor="settings-ics" className="block text-[13px]">
          {t('settings_calendar_url')}
        </label>
        <input
          id="settings-ics"
          type="password"
          autoComplete="off"
          placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
          value={calendar.icsUrl}
          onChange={event => setCalendar({ ...calendar, icsUrl: event.target.value })}
          onBlur={() => void save({ icsUrl: calendar.icsUrl })}
          className="w-full rounded-xl border bg-transparent px-2.5 py-1.5 font-mono text-[11.5px] text-foreground outline-none focus:border-primary/50"
        />
        <p className="text-[11.5px] text-muted-foreground">{t('settings_calendar_hint')}</p>
        <Button variant="default" size="sm" disabled={connecting} onClick={connect}>
          {connecting ? t('settings_calendar_connecting_short') : t('settings_calendar_connect')}
        </Button>
        {found && (
          <div className="rounded-xl border border-primary/40 bg-primary/10 p-2.5 text-[12px]">
            <p>{t('settings_calendar_found', [found.calendar])}</p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  const url = found.url;
                  setFound(null);
                  void save({ icsUrl: url, reminders: true });
                }}>
                {t('settings_calendar_use')}
              </Button>
              <Button variant="glass" size="sm" onClick={() => setFound(null)}>
                {t('skills_teach_cancel')}
              </Button>
            </div>
          </div>
        )}
        {status && (
          <p className={cn('text-[11.5px]', status.error ? 'text-destructive' : 'text-primary')}>{status.text}</p>
        )}
      </div>
      <Row title={t('settings_calendar_remind')}>
        <select
          aria-label={t('settings_calendar_remind')}
          value={calendar.reminders ? calendar.remindMinutes : 0}
          onChange={event => {
            const minutes = Number(event.target.value);
            void save(minutes === 0 ? { reminders: false } : { reminders: true, remindMinutes: minutes });
          }}
          className={SELECT}>
          <option value={0}>{t('settings_calendar_off')}</option>
          {[1, 5, 10, 15].map(minutes => (
            <option key={minutes} value={minutes}>
              {t('settings_calendar_minutes', [String(minutes)])}
            </option>
          ))}
        </select>
      </Row>
    </>
  );
}
