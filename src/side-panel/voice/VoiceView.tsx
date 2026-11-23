import { Keyboard, X } from 'lucide-react';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import { db } from '@extension/storage';
import type { ThreadMessage } from '@extension/storage';
import { useLive } from '../hooks/useLive';
import { useAssistantName } from '../hooks/useAssistant';
import { LiveOrb } from '../components/ui/live-orb';
import { Shimmer } from '../components/ai/shimmer';
import type { VoiceStatus } from '../layout/Header';

interface VoiceViewProps {
  status: Exclude<VoiceStatus, 'off' | 'paused'>;
  onEnd: () => void;
  onHide: () => void;
}

const STATUS_LABELS = {
  connecting: 'voice_status_connecting',
  listening: 'voice_status_listening',
  speaking: 'voice_status_speaking',
} as const;

// The orb's colours move faster the more is happening
const SPEED = { connecting: 0.4, listening: 1, speaking: 2.2 } as const;

/**
 * The spoken conversation: the orb, what it is doing, and the last few things said. It covers the
 * panel while it is on; Hide gives the panel back without ending it.
 */
export default function VoiceView({ status, onEnd, onHide }: VoiceViewProps) {
  const name = useAssistantName();
  // The conversation is kept in the newest thread tagged "voice"
  const recent = useLive(
    async (): Promise<ThreadMessage[]> => {
      const thread = (await db.threads.orderBy('updatedAt').reverse().toArray()).find(item =>
        item.tags.includes('voice'),
      );
      if (!thread) return [];
      return (await db.messages.where('threadId').equals(thread.id).sortBy('seq')).slice(-4);
    },
    [],
    [],
  );

  return (
    <section
      aria-label={t('voice_view')}
      className="bg-background/95 animate-in fade-in-0 absolute inset-0 z-20 flex flex-col backdrop-blur-xl">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(360px_360px_at_50%_34%,rgb(var(--primary-rgb)/0.18),transparent_70%)]"
      />
      <div className="relative flex items-center justify-between px-4 pt-4">
        <span className="label-mono">{t('voice_label', [name])}</span>
        <span className="text-muted-foreground font-mono text-[10.5px]">{t('voice_neverInCall')}</span>
      </div>

      <div className="relative flex flex-col items-center gap-5 pt-10">
        <div className={cn('transition-transform duration-500', status === 'speaking' && 'scale-105')}>
          <LiveOrb size={196} speed={SPEED[status]} label={t(STATUS_LABELS[status])} />
        </div>
        <div className="flex items-center gap-2 text-[14px] font-medium">
          {status === 'connecting' ? (
            <Shimmer as="span">{t(STATUS_LABELS[status])}</Shimmer>
          ) : (
            <>
              <span
                className={cn(
                  'size-2 rounded-full',
                  status === 'speaking' ? 'animate-pulse bg-call' : 'animate-pulse bg-primary',
                )}
              />
              {t(STATUS_LABELS[status])}
            </>
          )}
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col justify-end gap-3 overflow-hidden px-6 pb-2">
        {recent.map(message =>
          message.actor === 'user' ? (
            <p key={message.id} className="text-muted-foreground text-[13.5px] leading-relaxed">
              {t('voice_you')} · “{message.content}”
            </p>
          ) : (
            <p key={message.id} className="text-[16px] leading-snug tracking-[-0.01em]">
              {message.content}
            </p>
          ),
        )}
      </div>

      <div className="relative flex items-center justify-center gap-6 pb-8 pt-6">
        <button
          type="button"
          onClick={onHide}
          aria-label={t('voice_hide')}
          title={t('voice_hide')}
          className="glass text-foreground flex size-12 items-center justify-center rounded-full">
          <Keyboard className="size-5" />
        </button>
        <button
          type="button"
          onClick={onEnd}
          aria-label={t('voice_end')}
          title={t('voice_end')}
          className="bg-foreground text-background flex size-16 items-center justify-center rounded-full shadow-[0_10px_30px_rgba(0,0,0,0.5)]">
          <X className="size-6" strokeWidth={2.2} />
        </button>
        <span className="size-12" aria-hidden="true" />
      </div>
    </section>
  );
}
