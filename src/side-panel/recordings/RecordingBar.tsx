import { useEffect, useRef, useState } from 'react';
import { Square } from 'lucide-react';
import { t } from '@extension/i18n';
import { recordingStore } from '@extension/storage';
import { Button } from '../components/ui/button';
import { downloadRecording, screenRecorder } from './recorder';
import { useRecorder } from './useRecorder';

export const clockOf = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

function useClock(startedAt: number | null): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : now - startedAt;
}

/**
 * The bar at the top of the panel while a screen recording is on: a red mark, the timer, the task, and Stop. It
 * also asks before recording a whole window or screen, and, once a recording that could go nowhere else stops,
 * starts its download from the panel.
 */
export default function RecordingBar() {
  const state = useRecorder();
  const elapsed = useClock(state.phase === 'recording' ? state.startedAt : null);
  const followed = useRef<string | null>(null);

  // A recording this panel just made that neither Drive nor Ava Brain could take is downloaded at once
  useEffect(() => {
    const id = state.lastId;
    if (!id || followed.current === id) return;
    followed.current = id;
    let tries = 0;
    const timer = setInterval(async () => {
      const record = await recordingStore.get(id);
      tries += 1;
      if (record?.status === 'waiting_download') {
        clearInterval(timer);
        await downloadRecording(id);
      } else if (!record || record.status === 'saved' || record.status === 'failed' || tries > 60) {
        clearInterval(timer);
      }
    }, 500);
    return () => clearInterval(timer);
  }, [state.lastId]);

  if (state.phase === 'idle') {
    return state.note ? (
      <p role="alert" className="text-destructive px-3 pt-2 text-[12px]">
        {state.note}
      </p>
    ) : null;
  }

  if (state.phase === 'picking') {
    return (
      <div className="glass mx-2.5 mt-2 rounded-xl px-3 py-2 text-[12.5px]" role="status" data-recording="picking">
        {t('recording_picking')}
      </div>
    );
  }

  if (state.phase === 'confirm_surface') {
    return (
      <div
        className="border-hold/50 bg-hold/10 mx-2.5 mt-2 flex flex-col gap-2 rounded-xl border px-3 py-2 text-[12.5px]"
        role="alertdialog"
        aria-label={t('recording_wholeWarning')}
        data-recording="confirm">
        <span>{t('recording_wholeWarning')}</span>
        <div className="flex gap-1.5">
          <Button size="sm" variant="hold" onClick={() => screenRecorder.confirmSurface()}>
            {t('recording_recordAnyway')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => screenRecorder.cancel()}>
            {t('recording_cancel')}
          </Button>
        </div>
      </div>
    );
  }

  const remaining = state.maxMs - elapsed;
  return (
    <div
      className="border-destructive/50 bg-destructive/10 mx-2.5 mt-2 flex items-center gap-2 rounded-xl border px-3 py-1.5 text-[12.5px]"
      role="status"
      aria-live="polite"
      data-recording="live">
      <span className="bg-destructive size-2.5 shrink-0 animate-pulse rounded-full" aria-hidden />
      <span className="font-medium">{t('recording_live')}</span>
      <span className="font-mono tabular-nums" data-recording-timer>
        {clockOf(elapsed)}
      </span>
      <span className="text-muted-foreground min-w-0 flex-1 truncate" title={state.taskTitle}>
        {state.taskTitle}
        {!state.withMic && ` · ${t('recording_noMic')}`}
        {remaining < 60_000 && remaining > 0 && ` · ${clockOf(remaining)}`}
      </span>
      <Button
        size="sm"
        variant="destructive"
        disabled={state.phase === 'stopping'}
        aria-label={t('recording_stop_label')}
        onClick={() => void screenRecorder.stop('stop')}>
        <Square className="size-3" />
        {t('recording_stop')}
      </Button>
    </div>
  );
}
