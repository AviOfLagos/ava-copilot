import { BookOpen, ChevronDown, Disc, Mic, Plus, SlidersHorizontal } from 'lucide-react';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import { LiveOrb } from '../components/ui/live-orb';
import { ThinkingOrb } from '../components/ui/thinking-orb';

export type VoiceStatus = 'off' | 'connecting' | 'listening' | 'speaking';

const VOICE_LABELS = {
  connecting: 'voice_status_connecting',
  listening: 'voice_status_listening',
  speaking: 'voice_status_speaking',
} as const;

interface HeaderProps {
  title: string;
  listOpen: boolean;
  onToggleList: () => void;
  // Something is running somewhere: the presence orb thinks instead of watching
  busy: boolean;
  kbOpen: boolean;
  onToggleKb: () => void;
  recordingLabel: string | null;
  onNotes: () => void;
  voiceStatus: VoiceStatus;
  onVoice: () => void;
  onNewThread: () => void;
  onSettings: () => void;
  settingsOpen: boolean;
  activeCount: number;
  onStopAll: () => void;
}

const iconButton =
  'flex size-8 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground';

/**
 * The panel's header: the copilot's presence, what is open, and the few things you reach for most.
 */
export default function Header(props: HeaderProps) {
  const voiceOn = props.voiceStatus !== 'off';
  return (
    <header className="border-border/60 relative z-10 flex h-[52px] shrink-0 items-center gap-2 border-b px-2.5">
      <div className="flex size-7 items-center justify-center" aria-hidden="true">
        {props.busy ? <ThinkingOrb size={30} /> : <LiveOrb size={24} />}
      </div>
      <button
        type="button"
        onClick={props.onToggleList}
        aria-expanded={props.listOpen}
        aria-label={t('threads_list_title')}
        className="hover:bg-accent flex min-w-0 flex-1 items-center gap-1 rounded-lg px-1.5 py-1 text-left">
        <span className="truncate text-[13.5px] font-medium tracking-tight">{props.title}</span>
        <ChevronDown
          className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', props.listOpen && 'rotate-180')}
        />
      </button>

      {props.activeCount > 1 && (
        <button
          type="button"
          onClick={props.onStopAll}
          className="border-destructive/50 bg-destructive/15 rounded-full border px-2 py-0.5 text-[11px]">
          {t('threads_stopAll', [String(props.activeCount)])}
        </button>
      )}

      <nav aria-label={t('nav_panel')} className="flex items-center gap-0.5">
        <button
          type="button"
          className={iconButton}
          onClick={props.onToggleKb}
          aria-label={t('kb_title')}
          aria-pressed={props.kbOpen}
          title={t('kb_title')}>
          <BookOpen className="size-4" />
        </button>
        {props.recordingLabel ? (
          <button
            type="button"
            onClick={props.onNotes}
            aria-label={t('meeting_openNotes')}
            className="bg-destructive/80 flex h-7 items-center gap-1.5 rounded-full px-2.5 font-mono text-[11px] font-medium text-white">
            <span className="size-1.5 animate-pulse rounded-full bg-white" />
            {props.recordingLabel}
          </button>
        ) : (
          <button
            type="button"
            className={iconButton}
            onClick={props.onNotes}
            aria-label={t('meeting_take')}
            title={t('meeting_take')}>
            <Disc className="size-4" />
          </button>
        )}
        {voiceOn ? (
          <button
            type="button"
            onClick={props.onVoice}
            aria-label={t('voice_stop')}
            title={t('voice_stop')}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium',
              props.voiceStatus === 'speaking' ? 'border-call/50 bg-call/20' : 'border-primary/50 bg-primary/15',
            )}>
            <span className="size-1.5 animate-pulse rounded-full bg-current" />
            {t(VOICE_LABELS[props.voiceStatus as keyof typeof VOICE_LABELS])}
          </button>
        ) : (
          <button
            type="button"
            className={iconButton}
            onClick={props.onVoice}
            aria-label={t('voice_talk')}
            title={t('voice_talk')}>
            <Mic className="size-4" />
          </button>
        )}
        <button
          type="button"
          className={iconButton}
          onClick={props.onNewThread}
          aria-label={t('threads_new')}
          title={t('threads_new')}>
          <Plus className="size-4" />
        </button>
        <button
          type="button"
          className={iconButton}
          onClick={props.onSettings}
          aria-label={t('nav_settings_a11y')}
          aria-pressed={props.settingsOpen}
          title={t('nav_settings_a11y')}>
          <SlidersHorizontal className="size-4" />
        </button>
      </nav>
    </header>
  );
}
