import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { meetingStore, upcomingEventsStore } from '@extension/storage';
import type { UpcomingEvent } from '@extension/storage';
import { useTheme } from '../side-panel/layout/theme';

const meetingId = new URLSearchParams(location.search).get('meeting') ?? '';

/**
 * The small window that opens when notes start by themselves on a call the calendar does not
 * explain: what is it about? The answer guides the summary and the notes.
 */
export default function MeetingAsk() {
  useTheme();
  const [topic, setTopic] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const { events } = await upcomingEventsStore.get();
      const now = Date.now();
      const today = (events ?? []).filter((event: UpcomingEvent) => event.end > now - 3_600_000).slice(0, 3);
      const recent = (await meetingStore.list()).filter(meeting => meeting.topic && meeting.id !== meetingId);
      const names = [...today.map(event => event.title), ...recent.map(meeting => meeting.topic ?? '')];
      setSuggestions([...new Set(names.filter(Boolean))].slice(0, 4));
    })();
  }, []);

  const send = async (message: Record<string, unknown>) => {
    setBusy(true);
    await chrome.runtime.sendMessage({ ...message, meetingId }).catch(() => {});
    window.close();
  };

  return (
    <div className="aura flex min-h-screen flex-col gap-3 p-4 text-[13px]">
      <div className="flex items-center gap-2">
        <span className="size-2 animate-pulse rounded-full bg-destructive" />
        <h1 className="text-[14px] font-semibold tracking-tight">{t('ask_title')}</h1>
      </div>
      <p className="text-muted-foreground">{t('ask_question')}</p>

      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map(suggestion => (
            <button
              key={suggestion}
              type="button"
              disabled={busy}
              onClick={() => void send({ type: 'meeting_topic', topic: suggestion })}
              className="glass max-w-full truncate rounded-full px-3 py-1 text-[12px] hover:bg-accent">
              {suggestion}
            </button>
          ))}
        </div>
      )}

      <form
        className="flex gap-2"
        onSubmit={event => {
          event.preventDefault();
          if (topic.trim()) void send({ type: 'meeting_topic', topic });
        }}>
        <label htmlFor="ask-topic" className="sr-only">
          {t('ask_question')}
        </label>
        <input
          id="ask-topic"
          autoFocus
          value={topic}
          onChange={event => setTopic(event.target.value)}
          placeholder={t('ask_placeholder')}
          className="glass min-w-0 flex-1 rounded-xl px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50"
        />
        <button
          type="submit"
          disabled={busy || !topic.trim()}
          className="rounded-xl border border-primary/55 bg-primary/20 px-3 text-[12.5px] font-medium disabled:opacity-50">
          {t('ask_save')}
        </button>
      </form>

      <div className="mt-auto flex items-center justify-between text-[11.5px] text-muted-foreground">
        <span>{t('ask_captions_note')}</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void send({ type: 'meeting_not_this_call' })}
          className="shrink-0 underline-offset-2 hover:text-foreground hover:underline">
          {t('ask_not_this')}
        </button>
      </div>
    </div>
  );
}
