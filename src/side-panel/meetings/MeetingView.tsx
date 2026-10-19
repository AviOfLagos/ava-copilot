import { useEffect, useState } from 'react';
import { FiCopy, FiDownload, FiFileText } from 'react-icons/fi';
import { PiStopFill } from 'react-icons/pi';
import { t } from '@extension/i18n';
import { meetingStore, threadStore } from '@extension/storage';
import type { MeetingRecord, MeetingWarning } from '@extension/storage';
import { useLive } from '../hooks/useLive';
import { buttonClasses } from '../components/ui/button';
import { useAssistantName } from '../hooks/useAssistant';
import { recordingStatus } from './status';

type MeetingTab = 'summary' | 'live' | 'transcript' | 'ask';

interface MeetingViewProps {
  meetingId: string;
  onStop: () => void;
  onRetry: () => void;
  onOpenThread: (threadId: string) => void;
  // Asks a question about the meeting; resolves once the answer is in the thread
  onAsk: (question: string) => Promise<void>;
  onRefreshSummary: () => void;
  // Seconds into the meeting to scroll the transcript to, e.g. from a citation
  focusT?: number | null;
  isDarkMode?: boolean;
}

const WARNINGS: Record<MeetingWarning, Parameters<typeof t>[0]> = {
  silence: 'meeting_warning_silence',
  quota: 'meeting_warning_quota',
  no_mic: 'meeting_warning_noMic',
  tab_closed: 'meeting_warning_tabClosed',
  cap: 'meeting_warning_cap',
  transcription: 'meeting_warning_transcription',
  interrupted: 'meeting_warning_interrupted',
  nothing_captured: 'meeting_warning_nothingCaptured',
  captions_off: 'meeting_warning_captionsOff',
  audio_lost: 'meeting_warning_audioLost',
  note_failed: 'meeting_warning_noteFailed',
};

const LIVE_STATUS = {
  on: 'meeting_live_on',
  connecting: 'meeting_live_connecting',
  reconnecting: 'meeting_live_reconnecting',
  off: 'meeting_live_off',
} as const;

export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Seconds a meeting has been recording, ticking every second while it records. */
export function useElapsed(meeting: Pick<MeetingRecord, 'startedAt' | 'endedAt' | 'status'> | undefined): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (meeting?.status !== 'recording') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [meeting?.status]);
  if (!meeting) return 0;
  return ((meeting.endedAt ?? now) - meeting.startedAt) / 1000;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * A meeting while it records (live transcript and rolling summary) and after (the note).
 */
export default function MeetingView({
  meetingId,
  onStop,
  onRetry,
  onOpenThread,
  onAsk,
  onRefreshSummary,
  focusT = null,
}: MeetingViewProps) {
  const meeting = useLive(() => meetingStore.get(meetingId), [meetingId], undefined);
  const segments = useLive(() => meetingStore.segments(meetingId), [meetingId], []);
  // The line a citation points at: the first one said at or after its time
  const focusId =
    focusT !== null && focusT >= 0 ? (segments.find(segment => segment.tStart >= focusT - 1)?.id ?? null) : null;
  useEffect(() => {
    if (focusId) document.getElementById(`segment-${focusId}`)?.scrollIntoView({ block: 'center' });
  }, [focusId]);
  const threadId = meeting?.threadId ?? null;
  // Questions and answers live in the meeting's thread; the note posted there is shown above instead
  const answers = useLive(
    () => (threadId ? threadStore.messages(threadId) : Promise.resolve([])),
    [threadId],
    [],
  ).filter(message => !message.content.startsWith('# '));
  const elapsed = useElapsed(meeting);
  const [copied, setCopied] = useState(false);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const assistantName = useAssistantName();
  // Live while recording, the summary once done, the transcript when a citation points into it
  const [tab, setTab] = useState<MeetingTab>(focusT !== null && focusT >= 0 ? 'transcript' : 'live');
  useEffect(() => {
    if (focusT !== null && focusT >= 0) setTab('transcript');
  }, [focusT]);

  const ask = async () => {
    const text = question.trim();
    if (!text || asking) return;
    setAsking(true);
    try {
      await onAsk(text);
      setQuestion('');
    } finally {
      setAsking(false);
    }
  };

  if (!meeting) return null;

  const muted = 'text-muted-foreground';
  const card = 'glass rounded-2xl p-3 text-[13px] text-foreground';
  const heading = 'mb-1 text-sm font-semibold';
  const note = meeting.note;

  const status =
    meeting.status === 'recording'
      ? recordingStatus(meeting, segments.length, clock(elapsed))
      : meeting.status === 'finishing'
        ? t('meeting_status_finishing', [String(meeting.chunksDone), String(meeting.chunksTotal)])
        : meeting.status === 'failed'
          ? t('meeting_status_failed', [meeting.error ?? ''])
          : t('meeting_status_done', [clock(elapsed)]);

  const copy = async () => {
    await navigator.clipboard.writeText(meeting.markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const tabs: { id: MeetingTab; label: string; count?: number }[] = [
    { id: 'summary', label: t('meeting_tab_summary') },
    ...(meeting.status === 'recording' && meeting.live !== 'off'
      ? [{ id: 'live' as const, label: t('meeting_tab_live') }]
      : []),
    { id: 'transcript', label: t('meeting_tab_transcript'), count: segments.length },
    ...(threadId
      ? [{ id: 'ask' as const, label: t('meeting_tab_ask'), count: answers.filter(m => m.actor === 'user').length }]
      : []),
  ];
  const shown = tabs.some(item => item.id === tab) ? tab : 'summary';

  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <div className="shrink-0 px-3 pt-3">
        <div className={card}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold">{note?.title || meeting.title}</h2>
              <p className={`text-xs ${muted}`}>
                {meeting.platform}
                {meeting.source === 'captions' && ` · ${t('meeting_fromCaptions')}`}
              </p>
              <p
                role="status"
                className={`mt-1 flex items-center gap-1 ${meeting.status === 'recording' ? 'text-destructive' : muted}`}>
                {meeting.status === 'recording' && (
                  <span className="bg-destructive inline-block size-2 animate-pulse rounded-full" />
                )}
                {status}
              </p>
            </div>
            {meeting.status === 'recording' && (
              <button
                type="button"
                onClick={onStop}
                className="border-destructive/60 bg-destructive/25 flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3">
                <PiStopFill size={14} />
                {t('meeting_stop')}
              </button>
            )}
            {(meeting.status === 'failed' ||
              (meeting.status === 'finishing' && meeting.warnings.includes('transcription'))) && (
              <button type="button" onClick={onRetry} className={buttonClasses('default', 'sm')}>
                {t('meeting_retry')}
              </button>
            )}
          </div>
          {meeting.warnings.length > 0 && (
            <ul className="mt-2 space-y-1">
              {meeting.warnings.map(warning => (
                <li key={warning} role="alert" className="bg-muted rounded-xl border px-2.5 py-1.5 text-xs">
                  {t(WARNINGS[warning])}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div role="tablist" aria-label={t('meeting_tabs')} className="glass mt-2.5 flex gap-0.5 rounded-xl p-0.5">
          {tabs.map(item => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={shown === item.id}
              onClick={() => setTab(item.id)}
              className={`flex h-7 flex-1 items-center justify-center gap-1 rounded-[9px] text-[12px] transition-colors ${
                shown === item.id ? 'bg-accent text-foreground border' : 'text-muted-foreground hover:text-foreground'
              }`}>
              {item.id === 'live' && <span className="bg-destructive size-1.5 animate-pulse rounded-full" />}
              {item.label}
              {item.count ? <span className="font-mono text-[10px] opacity-70">{item.count}</span> : null}
            </button>
          ))}
        </div>
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {shown === 'summary' && (
          <>
            {note ? (
              <div className={`${card} space-y-3`}>
                <section>
                  <h3 className={heading}>{t('meeting_note_tldr')}</h3>
                  <ul className="list-disc pl-5">
                    {note.tldr.map(line => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3 className={heading}>{t('meeting_note_decisions')}</h3>
                  {note.decisions.length ? (
                    <ul className="list-disc pl-5">
                      {note.decisions.map(line => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className={muted}>{t('meeting_note_none')}</p>
                  )}
                </section>
                <section>
                  <h3 className={heading}>{t('meeting_note_actions')}</h3>
                  {note.actionItems.length ? (
                    <ul className="space-y-1">
                      {note.actionItems.map(item => (
                        <li key={`${item.owner}-${item.task}`}>
                          <span className="font-medium">{item.owner}</span>: {item.task}
                          {item.due && <span className={muted}> ({t('meeting_note_due', [item.due])})</span>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className={muted}>{t('meeting_note_none')}</p>
                  )}
                </section>
                <section>
                  <h3 className={heading}>{t('meeting_note_questions')}</h3>
                  {note.openQuestions.length ? (
                    <ul className="list-disc pl-5">
                      {note.openQuestions.map(line => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className={muted}>{t('meeting_note_none')}</p>
                  )}
                </section>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => void copy()}
                    className="flex items-center gap-1 rounded-md border px-2 py-1">
                    <FiCopy size={14} />
                    {copied ? t('meeting_copied') : t('meeting_copy')}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      download(`${(note.title || 'meeting').replace(/[^\w-]+/g, '-')}.md`, meeting.markdown)
                    }
                    className="flex items-center gap-1 rounded-md border px-2 py-1">
                    <FiDownload size={14} />
                    {t('meeting_download')}
                  </button>
                  {meeting.threadId && (
                    <button
                      type="button"
                      onClick={() => onOpenThread(meeting.threadId as string)}
                      className="flex items-center gap-1 rounded-md border px-2 py-1">
                      <FiFileText size={14} />
                      {t('meeting_openThread')}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              meeting.status === 'recording' && (
                <div className={card}>
                  <div className="flex items-center justify-between">
                    <h3 className={heading}>{t('meeting_summarySoFar')}</h3>
                    <button type="button" onClick={onRefreshSummary} className="text-primary text-xs hover:underline">
                      {t('meeting_refreshSummary')}
                    </button>
                  </div>
                  <p className={`whitespace-pre-wrap ${meeting.rollingSummary ? '' : muted}`}>
                    {meeting.rollingSummary || t('meeting_summaryPending')}
                  </p>
                </div>
              )
            )}
          </>
        )}
        {shown === 'live' && (
          <>
            {meeting.status === 'recording' && meeting.live !== 'off' && (
              <div className={card}>
                <h3 className={`${heading} flex items-center gap-2`}>
                  {t('meeting_live_title')}
                  <span className={`text-xs font-normal ${muted}`}>{t(LIVE_STATUS[meeting.live])}</span>
                </h3>
                <ol aria-label={t('meeting_live_title')} className="space-y-1">
                  {(meeting.liveCaptions ?? []).slice(-6).map(caption => (
                    <li key={`${caption.t}-${caption.text}`}>
                      <span className={`mr-1 tabular-nums ${muted}`}>{clock(caption.t)}</span>
                      {caption.text}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </>
        )}
        {shown === 'transcript' && (
          <>
            <div className={card}>
              <h3 className={heading}>{t('meeting_transcript')}</h3>
              {segments.length === 0 ? (
                <p className={muted}>
                  {meeting.status === 'recording' ? t('meeting_listening') : t('meeting_noTranscript')}
                </p>
              ) : (
                <ol aria-label={t('meeting_transcript')} className="space-y-1">
                  {segments.map(segment => (
                    <li
                      key={segment.id}
                      id={`segment-${segment.id}`}
                      className={segment.id === focusId ? 'bg-primary/15 rounded' : ''}>
                      <span className={`mr-1 tabular-nums ${muted}`}>{clock(segment.tStart)}</span>
                      {segment.speaker && <span className="font-medium">{segment.speaker}: </span>}
                      {segment.text}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </>
        )}
        {shown === 'ask' && (
          <>
            {threadId && (
              <div className={card}>
                <h3 className={heading}>{t('meeting_ask_title')}</h3>
                {answers.length > 0 && (
                  <ul aria-label={t('meeting_ask_title')} className="mb-2 space-y-2">
                    {answers.map(message => (
                      <li key={message.id} className={message.actor === 'user' ? 'font-medium' : 'whitespace-pre-wrap'}>
                        {message.content}
                      </li>
                    ))}
                  </ul>
                )}
                <form
                  className="flex gap-2"
                  onSubmit={event => {
                    event.preventDefault();
                    void ask();
                  }}>
                  <input
                    value={question}
                    onChange={event => setQuestion(event.target.value)}
                    placeholder={t('meeting_ask_placeholder')}
                    aria-label={t('meeting_ask_placeholder')}
                    className="bg-card text-foreground placeholder:text-muted-foreground focus:border-primary/50 min-w-0 flex-1 rounded-full border px-3 py-1.5 outline-none"
                  />
                  <button type="submit" disabled={asking} className={buttonClasses('default', 'sm')}>
                    {asking ? t('meeting_asking', [assistantName]) : t('meeting_ask_button')}
                  </button>
                </form>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
