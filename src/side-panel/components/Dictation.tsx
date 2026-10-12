import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { Loader2, X } from 'lucide-react';
import { t } from '@extension/i18n';
import type { SpeechStatus } from '../hooks/useSpeechInput';
import './ui/dictation.css';

// Bars in the level meter: the last couple of seconds of loudness, newest on the right
const BARS = 28;

function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The microphone's loudness moving across, so it is plain that the words are heard. */
function LevelBars({ level }: { level: MutableRefObject<number> }) {
  const barsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const history = new Array<number>(BARS).fill(0);
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      // With reduced motion the meter still shows the level, a few times a second
      if (now - last >= (reduced ? 250 : 55)) {
        last = now;
        history.shift();
        history.push(level.current);
        const bars = barsRef.current?.children;
        if (bars) {
          for (let index = 0; index < bars.length; index++) {
            (bars[index] as HTMLElement).style.transform = `scaleY(${Math.max(0.1, history[index]).toFixed(3)})`;
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [level]);

  return (
    <div ref={barsRef} className="stt-bars" aria-hidden="true">
      {Array.from({ length: BARS }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  );
}

/** How long the microphone has been on. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="stt-time">{elapsedText(now - since)}</span>;
}

interface ListeningStripProps {
  status: Exclude<SpeechStatus, 'idle'>;
  startedAt: number | null;
  level: MutableRefObject<number>;
  // The words go out as soon as they are written down
  sendWhenReady: boolean;
  onCancel: () => void;
}

/**
 * Takes the text box's place while dictating: the microphone starting, then a red dot, the level and the time
 * while it listens, then "Transcribing…" while the words are written down.
 */
export function ListeningStrip({ status, startedAt, level, sendWhenReady, onCancel }: ListeningStripProps) {
  const label =
    status === 'starting'
      ? t('chat_stt_starting')
      : status === 'listening'
        ? t('chat_stt_listening')
        : sendWhenReady
          ? t('chat_stt_transcribing_send')
          : t('chat_stt_transcribing');

  return (
    <div className="stt-strip" data-status={status}>
      {/* Read out when it changes: starting, listening, transcribing */}
      <span className="sr-only" role="status" aria-live="polite">
        {label}
      </span>
      {status === 'transcribing' ? (
        <>
          <Loader2 className="text-primary size-4 shrink-0 animate-spin" aria-hidden="true" />
          <span className="mo-lab-t truncate text-[13px]" aria-hidden="true">
            {label}
          </span>
        </>
      ) : (
        <>
          <span className="stt-dot" aria-hidden="true" />
          {status === 'listening' ? (
            <>
              <LevelBars level={level} />
              {startedAt !== null && <Elapsed since={startedAt} />}
            </>
          ) : (
            <span className="text-muted-foreground flex-1 truncate text-[13px]" aria-hidden="true">
              {label}
            </span>
          )}
          <button
            type="button"
            className="stt-cancel"
            onClick={onCancel}
            aria-label={t('chat_stt_cancel')}
            title={t('chat_stt_cancel')}>
            <X className="size-3.5" />
          </button>
        </>
      )}
    </div>
  );
}
