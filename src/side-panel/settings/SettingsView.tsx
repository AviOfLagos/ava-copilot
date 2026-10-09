import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import {
  COMMIT_KINDS,
  calendarSettingsStore,
  upcomingEventsStore,
  agentModelStore,
  gateSettingsStore,
  generalSettingsStore,
  kbSettingsStore,
  llmProviderStore,
  localDay,
  meetingSettingsStore,
  skillStore,
  usageStore,
} from '@extension/storage';
import type { CommitKind, SkillRecord } from '@extension/storage';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { saveTheme, useTheme } from '../layout/theme';
import type { ThemeChoice } from '../layout/theme';

const KIND_LABELS: Record<CommitKind, Parameters<typeof t>[0]> = {
  send: 'gate_kind_send',
  publish: 'gate_kind_publish',
  submit: 'gate_kind_submit',
  delete: 'gate_kind_delete',
  purchase: 'gate_kind_purchase',
  permission: 'gate_kind_permission',
};

const RETENTION_DAYS = [0, 30, 90, 180, 365];

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label}>
      <h3 className="label-mono mb-1.5 px-1">{label}</h3>
      <div className="glass divide-border/60 divide-y overflow-hidden rounded-2xl">{children}</div>
    </section>
  );
}

function Row({ title, hint, children }: { title: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">{title}</div>
        {hint && <div className="text-muted-foreground mt-0.5 text-[11.5px]">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

interface SettingsViewProps {
  onBack: () => void;
}

/**
 * Settings in the panel: the ones people change, without leaving the page. The full settings page
 * stays one tap away for providers, blocked sites and skill editing.
 */
export default function SettingsView({ onBack }: SettingsViewProps) {
  const { choice } = useTheme();
  const [models, setModels] = useState<{ planner: string; navigator: string; keyed: string[] } | null>(null);
  const [confirm, setConfirm] = useState<Record<CommitKind, boolean> | null>(null);
  const [cap, setCap] = useState(5);
  const [spent, setSpent] = useState(0);
  const [style, setStyle] = useState('');
  const [highlights, setHighlights] = useState(false);
  const [calendar, setCalendar] = useState({ icsUrl: '', remindMinutes: 5, reminders: true });
  const [calendarStatus, setCalendarStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [connecting, setConnecting] = useState(false);
  // A calendar the connector found, waiting for the user to choose it
  const [found, setFound] = useState<{ calendar: string; url: string } | null>(null);
  const [meeting, setMeeting] = useState({ includeMic: true, liveCaptions: true });
  const [memory, setMemory] = useState({
    indexChats: true,
    indexMeetings: true,
    retentionDays: 0,
    embedSource: 'auto' as 'auto' | 'gemini' | 'local',
  });
  const [skills, setSkills] = useState<SkillRecord[]>([]);

  useEffect(() => {
    void (async () => {
      const [agents, providers] = await Promise.all([
        agentModelStore.getAllAgentModels(),
        llmProviderStore.getAllProviders(),
      ]);
      const name = (config?: { modelName: string }) => config?.modelName ?? t('settings_model_none');
      setModels({
        planner: name(agents.planner),
        navigator: name(agents.navigator),
        keyed: Object.entries(providers)
          .filter(([, provider]) => provider.apiKey)
          .map(([id, provider]) => provider.name || id),
      });
      setConfirm((await gateSettingsStore.getSettings()).confirm);
      const general = await generalSettingsStore.getSettings();
      setCap(general.dailyCostCapUsd);
      setStyle(general.stylePrompt);
      setHighlights(general.displayHighlights);
      setCalendar(await calendarSettingsStore.getSettings());
      setSpent((await usageStore.getDay(localDay())).costUsd);
      const meetingSettings = await meetingSettingsStore.getSettings();
      setMeeting({ includeMic: meetingSettings.includeMic, liveCaptions: meetingSettings.liveCaptions });
      const kb = await kbSettingsStore.getSettings();
      setMemory({
        indexChats: kb.indexChats,
        indexMeetings: kb.indexMeetings,
        retentionDays: kb.retentionDays,
        embedSource: kb.embedSource,
      });
      setSkills(await skillStore.all());
    })();
    return skillStore.subscribe(() => void skillStore.all().then(setSkills));
  }, []);

  const toggleKind = async (kind: CommitKind) => {
    if (!confirm) return;
    await gateSettingsStore.setConfirm(kind, !confirm[kind]);
    setConfirm({ ...confirm, [kind]: !confirm[kind] });
  };

  const setMeetingSetting = async (changes: Partial<typeof meeting>) => {
    setMeeting({ ...meeting, ...changes });
    await meetingSettingsStore.updateSettings(changes);
  };

  const setMemorySetting = async (changes: Partial<typeof memory>) => {
    setMemory({ ...memory, ...changes });
    await kbSettingsStore.updateSettings(changes);
    // Retention and newly added sources apply right away
    await chrome.runtime.sendMessage({ type: 'kb_sweep' }).catch(() => {});
  };

  const saveCalendar = async (changes: Partial<typeof calendar>) => {
    const next = { ...calendar, ...changes };
    setCalendar(next);
    await calendarSettingsStore.updateSettings(changes);
    if (!('icsUrl' in changes)) return;
    setCalendarStatus(null);
    const reply = await chrome.runtime.sendMessage({ type: 'kb_calendar_refresh' }).catch(() => null);
    if (!next.icsUrl.trim()) return;
    if (!reply?.ok) {
      setCalendarStatus({ text: reply?.error ?? t('errors_unknown'), error: true });
      return;
    }
    const { events } = await upcomingEventsStore.get();
    setCalendarStatus({ text: t('settings_calendar_ok', [String(events.length)]), error: false });
  };

  const select = 'rounded-lg border bg-card px-2 py-1 text-[12px] text-foreground outline-none focus:border-primary/50';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pt-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-3.5" />
          {t('today_back')}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-4 pt-2">
        <Section label={t('settings_model')}>
          <Row
            title={
              models?.keyed.length ? t('settings_model_keys', [models.keyed.join(', ')]) : t('settings_model_noKeys')
            }
            hint={models && t('settings_model_roles', [models.planner, models.navigator])}>
            <span
              className={cn(
                'size-2 shrink-0 rounded-full',
                models?.keyed.length ? 'bg-primary shadow-[0_0_8px_rgb(var(--primary-rgb))]' : 'bg-destructive',
              )}
            />
          </Row>
        </Section>

        <Section label={t('options_gate_header')}>
          <div className="flex flex-wrap gap-1.5 p-3">
            {COMMIT_KINDS.map(kind => (
              <button
                key={kind}
                type="button"
                aria-pressed={confirm?.[kind] ?? true}
                onClick={() => void toggleKind(kind)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[12px] transition-colors',
                  confirm?.[kind] !== false
                    ? 'border-hold/50 bg-hold/15 text-hold-foreground'
                    : 'border-input text-muted-foreground line-through',
                )}>
                {t(KIND_LABELS[kind])}
              </button>
            ))}
          </div>
          <p className="text-muted-foreground px-3 pb-3 text-[11.5px]">{t('settings_gate_hint')}</p>
        </Section>

        <Section label={t('settings_spending')}>
          <div className="px-3 py-2.5">
            <div className="flex items-center justify-between">
              <label htmlFor="settings-cap" className="text-[13px]">
                {t('settings_cap')}
              </label>
              <div className="flex items-center gap-1 font-mono text-[12.5px]">
                <span className="text-muted-foreground">${spent.toFixed(2)} /</span>
                <span>$</span>
                <input
                  id="settings-cap"
                  type="number"
                  min={0}
                  step={0.5}
                  value={cap}
                  onChange={event => {
                    const value = Number.parseFloat(event.target.value);
                    if (Number.isFinite(value) && value >= 0) {
                      setCap(value);
                      void generalSettingsStore.updateSettings({ dailyCostCapUsd: value });
                    }
                  }}
                  className="bg-card focus:border-primary/50 w-14 rounded-md border px-1.5 py-0.5 text-right outline-none"
                />
              </div>
            </div>
            <div className="bg-muted mt-2.5 h-1.5 rounded">
              <div
                className="bg-primary h-1.5 rounded"
                style={{ width: `${Math.min(100, (spent / Math.max(cap, 0.01)) * 100)}%` }}
              />
            </div>
          </div>
        </Section>

        <Section label={t('settings_writing')}>
          <div className="p-3">
            <label htmlFor="settings-style" className="sr-only">
              {t('settings_writing')}
            </label>
            <textarea
              id="settings-style"
              rows={3}
              value={style}
              onChange={event => setStyle(event.target.value)}
              onBlur={() => void generalSettingsStore.updateSettings({ stylePrompt: style })}
              className="text-foreground focus:border-primary/50 w-full resize-none rounded-xl border bg-transparent p-2 text-[12.5px] leading-relaxed outline-none"
            />
          </div>
        </Section>

        <Section label={t('settings_agent')}>
          <Row title={t('settings_highlights')} hint={t('settings_highlights_hint')}>
            <Switch
              label={t('settings_highlights')}
              checked={highlights}
              onChange={value => {
                setHighlights(value);
                void generalSettingsStore.updateSettings({ displayHighlights: value });
              }}
            />
          </Row>
        </Section>

        <Section label={t('settings_calendar')}>
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
              onBlur={() => void saveCalendar({ icsUrl: calendar.icsUrl })}
              className="w-full rounded-xl border bg-transparent px-2.5 py-1.5 font-mono text-[11.5px] text-foreground outline-none focus:border-primary/50"
            />
            <p className="text-[11.5px] text-muted-foreground">{t('settings_calendar_hint')}</p>
            <Button
              variant="default"
              size="sm"
              disabled={connecting}
              onClick={() => {
                setConnecting(true);
                setCalendarStatus({ text: t('settings_calendar_connecting'), error: false });
                void chrome.runtime
                  .sendMessage({ type: 'kb_calendar_connect' })
                  .then((reply: { ok: boolean; error?: string; calendar?: string; url?: string } | undefined) => {
                    if (!reply?.ok || !reply.url) {
                      setCalendarStatus({ text: reply?.error ?? t('errors_unknown'), error: true });
                      return;
                    }
                    setCalendarStatus(null);
                    setFound({ calendar: reply.calendar ?? '', url: reply.url });
                  })
                  .finally(() => setConnecting(false));
              }}>
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
                      void saveCalendar({ icsUrl: url, reminders: true });
                    }}>
                    {t('settings_calendar_use')}
                  </Button>
                  <Button variant="glass" size="sm" onClick={() => setFound(null)}>
                    {t('skills_teach_cancel')}
                  </Button>
                </div>
              </div>
            )}
            {calendarStatus && (
              <p className={cn('text-[11.5px]', calendarStatus.error ? 'text-destructive' : 'text-primary')}>
                {calendarStatus.text}
              </p>
            )}
          </div>
          <Row title={t('settings_calendar_remind')}>
            <select
              aria-label={t('settings_calendar_remind')}
              value={calendar.reminders ? calendar.remindMinutes : 0}
              onChange={event => {
                const minutes = Number(event.target.value);
                void saveCalendar(minutes === 0 ? { reminders: false } : { reminders: true, remindMinutes: minutes });
              }}
              className={select}>
              <option value={0}>{t('settings_calendar_off')}</option>
              {[1, 5, 10, 15].map(minutes => (
                <option key={minutes} value={minutes}>
                  {t('settings_calendar_minutes', [String(minutes)])}
                </option>
              ))}
            </select>
          </Row>
        </Section>

        <Section label={t('settings_meetings')}>
          <Row title={t('options_meetings_includeMic')}>
            <Switch
              label={t('options_meetings_includeMic')}
              checked={meeting.includeMic}
              onChange={value => void setMeetingSetting({ includeMic: value })}
            />
          </Row>
          <Row title={t('options_meetings_liveCaptions')}>
            <Switch
              label={t('options_meetings_liveCaptions')}
              checked={meeting.liveCaptions}
              onChange={value => void setMeetingSetting({ liveCaptions: value })}
            />
          </Row>
        </Section>

        <Section label={t('settings_memory')}>
          <Row title={t('options_kb_indexChats')}>
            <Switch
              label={t('options_kb_indexChats')}
              checked={memory.indexChats}
              onChange={value => void setMemorySetting({ indexChats: value })}
            />
          </Row>
          <Row title={t('options_kb_indexMeetings')}>
            <Switch
              label={t('options_kb_indexMeetings')}
              checked={memory.indexMeetings}
              onChange={value => void setMemorySetting({ indexMeetings: value })}
            />
          </Row>
          <Row title={t('settings_embed')} hint={t('settings_embed_hint')}>
            <select
              aria-label={t('settings_embed')}
              value={memory.embedSource}
              onChange={event =>
                void setMemorySetting({ embedSource: event.target.value as typeof memory.embedSource })
              }
              className={select}>
              <option value="auto">{t('settings_embed_auto')}</option>
              <option value="gemini">Gemini</option>
              <option value="local">{t('settings_embed_local')}</option>
            </select>
          </Row>
          <Row title={t('options_kb_retention')}>
            <select
              aria-label={t('options_kb_retention')}
              value={memory.retentionDays}
              onChange={event => void setMemorySetting({ retentionDays: Number(event.target.value) })}
              className={select}>
              {RETENTION_DAYS.map(days => (
                <option key={days} value={days}>
                  {days === 0 ? t('options_kb_retention_forever') : t('options_kb_retention_days', [String(days)])}
                </option>
              ))}
            </select>
          </Row>
        </Section>

        <Section label={t('options_skills_header')}>
          {skills.map(skill => (
            <Row key={skill.id} title={`/${skill.id}`} hint={skill.description || undefined}>
              <Switch
                label={`/${skill.id}`}
                checked={skill.enabled}
                onChange={value => void skillStore.setEnabled(skill.id, value)}
              />
            </Row>
          ))}
        </Section>

        <Section label={t('settings_look')}>
          <div role="radiogroup" aria-label={t('settings_look')} className="grid grid-cols-3 gap-1 p-1">
            {(['dark', 'light', 'system'] as ThemeChoice[]).map(option => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={choice === option}
                onClick={() => saveTheme(option)}
                className={cn(
                  'h-8 rounded-xl text-[12.5px] transition-colors',
                  choice === option
                    ? 'border bg-accent text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}>
                {t(`settings_look_${option}`)}
              </button>
            ))}
          </div>
        </Section>

        <Button variant="glass" size="lg" onClick={() => void chrome.runtime.openOptionsPage()}>
          <ExternalLink className="size-4" />
          {t('settings_full')}
        </Button>
      </div>
    </div>
  );
}
