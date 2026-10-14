import { AudioLines } from 'lucide-react';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import { db } from '@extension/storage';
import type { ThreadRecord } from '@extension/storage';
import { useLive } from '../hooks/useLive';
import { useAssistantName } from '../hooks/useAssistant';

interface VoiceThreadBarProps {
  threadId: string;
  // The conversation is on and kept in this chat: typing goes to it
  live: boolean;
  onBackToVoice: () => void;
  onOpenThread: (id: string) => void;
}

const DOT: Record<ThreadRecord['status'], string> = {
  running: 'bg-primary animate-pulse',
  waiting_confirm: 'bg-hold',
  error: 'bg-destructive',
  idle: 'bg-muted-foreground/60',
};

/**
 * Above a voice conversation's chat: while it is on, that typing here goes to the same conversation and a way
 * back to the full voice screen; and the tasks Ava started from it, each a click away.
 */
export default function VoiceThreadBar({ threadId, live, onBackToVoice, onOpenThread }: VoiceThreadBarProps) {
  const name = useAssistantName();
  const tasks = useLive(
    async () =>
      (await db.threads.filter(thread => thread.voiceThreadId === threadId).toArray()).sort(
        (a, b) => b.createdAt - a.createdAt,
      ),
    [threadId],
    [],
  );
  if (!live && tasks.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-3 pt-2">
      {live && (
        <div
          role="status"
          className="border-primary/30 bg-primary/10 flex items-center gap-2 rounded-xl border px-2.5 py-1.5 text-[12px]">
          <span className="bg-primary size-2 shrink-0 animate-pulse rounded-full" aria-hidden="true" />
          <span className="min-w-0 flex-1 leading-snug">{t('voice_threadLive', [name])}</span>
          <button
            type="button"
            onClick={onBackToVoice}
            className="glass hover:bg-accent flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-medium">
            <AudioLines className="size-3.5" aria-hidden="true" />
            {t('voice_backToVoice')}
          </button>
        </div>
      )}
      {tasks.length > 0 && (
        <nav aria-label={t('voice_tasksStarted')} className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
          <span className="label-mono shrink-0">{t('voice_tasksStarted')}</span>
          {tasks.slice(0, 8).map(task => (
            <button
              key={task.id}
              type="button"
              onClick={() => onOpenThread(task.id)}
              title={task.title}
              className="bg-secondary hover:bg-accent flex max-w-[180px] shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px]">
              <span className={cn('size-1.5 shrink-0 rounded-full', DOT[task.status])} aria-hidden="true" />
              <span className="truncate">{task.title || t('threads_untitled')}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
