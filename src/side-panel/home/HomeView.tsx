import { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { BookOpen, BookmarkPlus, CalendarClock, Disc, FileText, Sparkles, Sunrise } from 'lucide-react';
import { t } from '@extension/i18n';
import { skillStore, upcomingEventsStore, briefSettingsStore } from '@extension/storage';
import type { UpcomingEvent } from '@extension/storage';
import { matchSkills } from '@src/background/skills/match';
import { LiveOrb } from '../components/ui/live-orb';
import { DayStrip, useToday } from '../today/TodayView';

interface Starter {
  id: string;
  icon: LucideIcon;
  title: string;
  tag: string;
  run: () => void;
}

interface HomeViewProps {
  onPrompt: (text: string) => void;
  onOpenKb: () => void;
  onTakeNotes: () => void;
  onSavePage: () => void;
  onOpenToday: () => void;
  // Opens a chat by id: today's morning brief
  onOpenThread: (threadId: string) => void;
  children?: React.ReactNode;
}

/** Today's morning brief's chat, once it is made. */
function useTodaysBrief(): string | null {
  const [threadId, setThreadId] = useState<string | null>(null);
  useEffect(() => {
    const load = () =>
      void briefSettingsStore.getSettings().then(settings => {
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        setThreadId(settings.lastDay === today ? settings.lastThreadId : null);
      });
    load();
    return briefSettingsStore.subscribe(load);
  }, []);
  return threadId;
}

const MEETING_HOSTS = /(^|\.)(meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com)$/;

function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return t('home_greeting_night');
  if (hour < 12) return t('home_greeting_morning');
  if (hour < 18) return t('home_greeting_afternoon');
  return t('home_greeting_evening');
}

/** The tab the user is looking at, so suggestions can fit it. */
function useActiveTab() {
  const [tab, setTab] = useState<{ url: string; host: string } | null>(null);
  useEffect(() => {
    const read = async () => {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!active?.url || !/^https?:/.test(active.url)) return setTab(null);
      setTab({ url: active.url, host: new URL(active.url).host.replace(/^www\./, '') });
    };
    void read();
    const onActivated = () => void read();
    const onUpdated = (_id: number, info: { url?: string }) => info.url && void read();
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);
  return tab;
}

/** The next meeting from the calendar, kept fresh by the background, ticking each minute. */
function useNextMeeting(): UpcomingEvent | null {
  const [events, setEvents] = useState<UpcomingEvent[]>([]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const read = () => void upcomingEventsStore.get().then(value => setEvents(value?.events ?? []));
    read();
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    const unsubscribe = upcomingEventsStore.subscribe(read);
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, []);
  // Within the next 12 hours, or under way
  return events.find(event => event.end > now && event.start < now + 12 * 3_600_000) ?? null;
}

/**
 * The first screen: the orb, a greeting, and a few things worth doing on the page you are on.
 */
export default function HomeView({
  onPrompt,
  onOpenKb,
  onTakeNotes,
  onSavePage,
  onOpenToday,
  onOpenThread,
  children,
}: HomeViewProps) {
  const briefId = useTodaysBrief();
  const tab = useActiveTab();
  const today = useToday();
  const next = useNextMeeting();
  const [skillId, setSkillId] = useState<string | null>(null);

  useEffect(() => {
    if (!tab) return setSkillId(null);
    void skillStore.enabled().then(skills => {
      const match = matchSkills(skills, { url: tab.url, task: '' })[0];
      setSkillId(match?.skill.id ?? null);
    });
  }, [tab]);

  const starters: Starter[] = [];
  if (briefId) {
    starters.push({
      id: 'brief',
      icon: Sunrise,
      title: t('brief_open'),
      tag: t('settings_brief'),
      run: () => onOpenThread(briefId),
    });
  }
  if (tab && skillId) {
    starters.push({
      id: 'skill',
      icon: Sparkles,
      title: t('home_starter_skill', [tab.host]),
      tag: `/${skillId}`,
      run: () => onPrompt(`/${skillId} `),
    });
  }
  if (tab) {
    starters.push({
      id: 'summarize',
      icon: FileText,
      title: t('home_starter_summarize'),
      tag: tab.host,
      run: () => onPrompt(t('home_starter_summarizePrompt')),
    });
  }
  starters.push({
    id: 'memory',
    icon: BookOpen,
    title: t('home_starter_memory'),
    tag: t('home_tag_memory'),
    run: onOpenKb,
  });
  if (tab && MEETING_HOSTS.test(tab.host)) {
    starters.push({ id: 'notes', icon: Disc, title: t('home_starter_notes'), tag: tab.host, run: onTakeNotes });
  } else if (tab) {
    starters.push({
      id: 'save',
      icon: BookmarkPlus,
      title: t('home_starter_save'),
      tag: t('home_tag_memory'),
      run: onSavePage,
    });
  }

  return (
    <div className="flex flex-col gap-5 px-4 pb-4 pt-6">
      <div className="flex items-center gap-4">
        <LiveOrb size={64} label={t('home_orb')} />
        <h1 className="text-[24px] font-medium leading-tight tracking-[-0.03em]">
          {greeting()}
          <br />
          <span className="text-muted-foreground">{t('home_subtitle')}</span>
        </h1>
      </div>

      {next && (
        <section
          aria-label={t('home_next_meeting')}
          className="flex items-center gap-3 rounded-2xl border border-call/40 bg-call/10 p-3.5">
          <CalendarClock className="size-5 shrink-0 text-call" strokeWidth={1.75} />
          <div className="min-w-0 flex-1">
            <div className="label-mono">{t('home_next_meeting')}</div>
            <div className="truncate text-[13.5px] font-medium">{next.title}</div>
            <div className="font-mono text-[11px] text-muted-foreground">
              {new Date(next.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} ·{' '}
              {next.start <= Date.now()
                ? t('home_now')
                : t('home_in_minutes', [String(Math.round((next.start - Date.now()) / 60_000))])}
            </div>
          </div>
          {next.joinUrl && (
            <button
              type="button"
              onClick={() => void chrome.tabs.create({ url: next.joinUrl!, active: true })}
              className="h-8 shrink-0 rounded-full border border-call/50 bg-call/20 px-3.5 text-[12.5px] font-medium">
              {t('home_join')}
            </button>
          )}
        </section>
      )}

      <section aria-label={t('home_suggestions')} className="grid grid-cols-2 gap-2.5">
        {starters.slice(0, 4).map(starter => (
          <button
            key={starter.id}
            type="button"
            onClick={starter.run}
            className="glass hover:bg-accent flex flex-col gap-2.5 rounded-2xl p-3.5 text-left transition-colors">
            <starter.icon className="text-primary size-[18px]" strokeWidth={1.75} />
            <span className="text-[13px] leading-snug">{starter.title}</span>
            <span className="text-muted-foreground truncate font-mono text-[10.5px]">{starter.tag}</span>
          </button>
        ))}
      </section>

      {today && (
        <button
          type="button"
          onClick={onOpenToday}
          aria-label={t('today_open')}
          className="glass hover:bg-accent flex flex-col gap-2.5 rounded-2xl p-3.5 text-left transition-colors">
          <div className="flex w-full items-center justify-between">
            <span className="label-mono">{t('today_title')}</span>
            <span className="text-muted-foreground font-mono text-[10.5px]">
              {t('today_mini', [String(today.stepsTaken), String(today.heldSent + today.heldStopped)])}
            </span>
          </div>
          <DayStrip today={today} compact />
        </button>
      )}

      {children}
    </div>
  );
}
