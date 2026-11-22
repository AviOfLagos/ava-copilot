import { useEffect, useState } from 'react';
import { Video } from 'lucide-react';
import { t } from '@extension/i18n';
import { recordingsDb, recordingStore } from '@extension/storage';
import type { RecordingRecord, Task } from '@extension/storage';
import { Button } from '../components/ui/button';
import { useLive } from '../hooks/useLive';
import { downloadRecording, screenRecorder } from './recorder';
import { useRecorder } from './useRecorder';

async function request<T>(message: Record<string, unknown>): Promise<T> {
  const reply = (await chrome.runtime.sendMessage({ ...message, requestId: crypto.randomUUID() })) as
    { type?: string; error?: string; result?: T } | undefined;
  if (!reply) throw new Error('The background did not answer.');
  if (reply.type === 'error') throw new Error(reply.error || 'Something went wrong.');
  return reply.result as T;
}

/** "~/Movies/…" rather than the whole home folder. */
export const shortPath = (path: string) => path.replace(/^\/Users\/[^/]+/, '~');

/**
 * Starts a recording for a task. It must be called straight from the click: `getDisplayMedia` runs before
 * anything else is awaited.
 */
export function recordTask(task: Pick<Task, 'id' | 'title'>): boolean {
  return screenRecorder.start({ id: task.id, title: task.title });
}

/** The camera button on a task's row: one click opens the browser's picker. */
export function RecordButton({ task }: { task: Pick<Task, 'id' | 'title'> }) {
  const state = useRecorder();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={t('recording_record_for', [task.title])}
      title={t('recording_record')}
      disabled={state.phase !== 'idle'}
      onClick={() => recordTask(task)}>
      <Video className="size-3.5" />
    </Button>
  );
}

function where(record: RecordingRecord): string {
  const saved = record.saved;
  if (record.status === 'recording') return t('recording_now');
  if (record.status === 'captured' || record.status === 'saving') {
    if (record.upload && record.bytes) {
      return t('recording_saving_pct', [String(Math.min(99, Math.floor((record.upload.bytes / record.bytes) * 100)))]);
    }
    return t('recording_saving');
  }
  if (record.status === 'waiting_download') return t('recording_waiting');
  if (record.status === 'failed') return t('recording_failed', [record.error ?? '']);
  if (saved?.where === 'drive') {
    return record.share.state === 'shared' ? t('recording_shared') : t('recording_inDrive', [saved.folder]);
  }
  if (saved?.where === 'brain') return t('recording_onMac', [shortPath(saved.path)]);
  if (saved?.where === 'download') return t('recording_downloaded', [saved.fileName]);
  return '';
}

function RecordingRow({ record }: { record: RecordingRecord }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const local = useLive(() => recordingStore.hasChunks(record.id), [record.id, record.status], false);
  useEffect(() => () => void (playing && URL.revokeObjectURL(playing)), [playing]);

  const act = async (message: Record<string, unknown>) => {
    setError('');
    setBusy(true);
    try {
      await request(message);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const play = async () => {
    if (playing) {
      setPlaying(null);
      return;
    }
    const blob = await recordingStore.blob(record.id, record.mimeType);
    if (blob) setPlaying(URL.createObjectURL(blob));
  };
  const drive = record.saved?.where === 'drive' ? record.saved : null;
  const shared = record.share.state === 'shared' ? record.share.link : null;
  const done = record.status === 'saved';
  const seconds = Math.round(record.durationMs / 1000);

  return (
    <li className="flex flex-col gap-1" data-recording-id={record.id} data-recording-status={record.status}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-foreground inline-flex items-center gap-1">
          <Video className="size-3" aria-hidden />
          {`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}
        </span>
        <span data-recording-where>{where(record)}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {local && record.status !== 'recording' && (
          <Button size="sm" variant="ghost" onClick={() => void play()}>
            {playing ? t('recording_hide') : t('recording_play')}
          </Button>
        )}
        {drive && (drive.webViewLink || shared) && (
          <a
            className="text-muted-foreground hover:text-foreground inline-flex h-8 items-center px-2 text-xs underline-offset-2 hover:underline"
            href={shared ?? drive.webViewLink ?? '#'}
            target="_blank"
            rel="noreferrer">
            {t('recording_open')}
          </a>
        )}
        {drive && !shared && done && (
          <Button
            size="sm"
            variant="glass"
            disabled={busy}
            title={t('recording_share_hint')}
            onClick={() => void act({ type: 'recordings_share', id: record.id })}>
            {t('recording_share')}
          </Button>
        )}
        {shared && (
          <>
            <Button
              size="sm"
              variant="glass"
              onClick={() =>
                void navigator.clipboard.writeText(shared).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }>
              {copied ? t('recording_copied') : t('recording_copy')}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => void act({ type: 'recordings_unshare', id: record.id })}>
              {t('recording_unshare')}
            </Button>
          </>
        )}
        {local &&
          (record.status === 'waiting_download' ||
            record.status === 'failed' ||
            record.saved?.where === 'download') && (
            <Button
              size="sm"
              variant="glass"
              onClick={() =>
                void downloadRecording(record.id).then(ok => !ok && setError(t('recording_failed', ['—'])))
              }>
              {t('recording_download')}
            </Button>
          )}
        {local && (record.status === 'failed' || record.status === 'waiting_download') && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void act({ type: 'recordings_save', id: record.id })}>
            {t('recording_retry')}
          </Button>
        )}
      </div>
      {playing && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video src={playing} controls className="w-full rounded-lg" data-recording-player />
      )}
      {error && (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      )}
    </li>
  );
}

/** A task's recordings under its row: where each one is, and Share / Stop sharing for those in Drive. */
export function TaskRecordings({ task }: { task: Pick<Task, 'id' | 'title' | 'mergedIds'> }) {
  // A task merged into this one keeps its recordings here
  const ids = [task.id, ...(task.mergedIds ?? [])];
  const records = useLive(
    () => recordingsDb.recordings.where('taskId').anyOf(ids).reverse().sortBy('startedAt'),
    [ids.join(',')],
    [] as RecordingRecord[],
  );
  if (records.length === 0) return null;
  return (
    <ul
      className="text-muted-foreground flex flex-col gap-1.5 pl-5 text-[11.5px]"
      aria-label={t('recording_list', [task.title])}>
      {records.map(record => (
        <RecordingRow key={record.id} record={record} />
      ))}
    </ul>
  );
}
