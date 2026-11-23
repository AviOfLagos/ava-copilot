import { Disc, Menu, Mic, SquarePen } from 'lucide-react';
import { TEXT_SCALES, appearanceSettingsStore } from '@extension/storage';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import { LiveOrb } from '../components/ui/live-orb';
import { ThinkingOrb } from '../components/ui/thinking-orb';
import Breadcrumbs from './Breadcrumbs';
import type { Crumb } from './Breadcrumbs';
import { useAssistantName } from '../hooks/useAssistant';
import { useStoreSettings } from '../settings/sections/ui';
import PersonalityPicker from '../personalities/PersonalityPicker';
import SetupIndicator from '../setup/SetupIndicator';
import AmbientIndicator from '../ambient/AmbientIndicator';

export type VoiceStatus = 'off' | 'connecting' | 'listening' | 'speaking' | 'paused';

const VOICE_LABELS = {
  connecting: 'voice_status_connecting',
  listening: 'voice_status_listening',
  speaking: 'voice_status_speaking',
  paused: 'voice_status_paused',
} as const;

interface HeaderProps {
  crumbs: Crumb[];
  menuOpen: boolean;
  onMenu: () => void;
  // Something is running somewhere: the presence orb thinks instead of watching
  busy: boolean;
  recordingLabel: string | null;
  // Notes run but nothing has been taken down yet: the pill stays grey and still
  recordingIdle?: boolean;
  onNotes: () => void;
  voiceStatus: VoiceStatus;
  onVoice: () => void;
  onNewThread: () => void;
  activeCount: number;
  onStopAll: () => void;
  // The workspace of the chat in front, for the personality picker
  workspaceId: string | null;
  onPersonalities: () => void;
}

const iconButton =
  'flex size-8 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground';

/** A− and A+: the text one step smaller or larger, for every page, at once. */
function TextSizeButtons() {
  const settings = useStoreSettings(appearanceSettingsStore);
  const scale = settings?.textScale ?? 100;
  return (
    <div className="flex items-center" role="group" aria-label={t('settings_look_textSize')}>
      <button
        type="button"
        className={cn(iconButton, 'w-6 text-[11px] font-semibold disabled:opacity-40')}
        disabled={scale <= TEXT_SCALES[0]}
        onClick={() => void appearanceSettingsStore.stepText(-1)}
        aria-label={t('settings_look_textSmaller')}
        title={`${t('settings_look_textSmaller')} (${scale}%)`}>
        A−
      </button>
      <button
        type="button"
        className={cn(iconButton, 'w-6 text-[13px] font-semibold disabled:opacity-40')}
        disabled={scale >= TEXT_SCALES[TEXT_SCALES.length - 1]}
        onClick={() => void appearanceSettingsStore.stepText(1)}
        aria-label={t('settings_look_textLarger')}
        title={`${t('settings_look_textLarger')} (${scale}%)`}>
        A+
      </button>
    </div>
  );
}

/**
 * The panel's header: the copilot's presence, what is open, and the few things you reach for most.
 */
export default function Header(props: HeaderProps) {
  const voiceOn = props.voiceStatus !== 'off';
  const name = useAssistantName();
  return (
    <header className="border-border/60 relative z-10 flex h-[52px] shrink-0 items-center gap-2 border-b px-2.5">
      <div className="flex size-7 items-center justify-center" aria-hidden="true">
        {props.busy ? <ThinkingOrb size={30} /> : <LiveOrb size={24} />}
      </div>
      <PersonalityPicker workspaceId={props.workspaceId} onManage={props.onPersonalities} />
      <button
        type="button"
        onClick={props.onMenu}
        aria-expanded={props.menuOpen}
        aria-label={t('nav_menu')}
        title={t('nav_menu')}
        className={iconButton}>
        <Menu className="size-4" />
      </button>
      <Breadcrumbs crumbs={props.crumbs} />

      {props.activeCount > 1 && (
        <button
          type="button"
          onClick={props.onStopAll}
          className="border-destructive/50 bg-destructive/15 rounded-full border px-2 py-0.5 text-[11px]">
          {t('threads_stopAll', [String(props.activeCount)])}
        </button>
      )}

      <nav aria-label={t('nav_panel')} className="flex items-center gap-0.5">
        <TextSizeButtons />
        <SetupIndicator />
        <AmbientIndicator />
        {props.recordingLabel ? (
          <button
            type="button"
            onClick={props.onNotes}
            aria-label={t('meeting_openNotes')}
            title={props.recordingIdle ? t('meeting_auto_waitingWords') : undefined}
            className={`flex h-7 items-center gap-1.5 rounded-full px-2.5 font-mono text-[11px] font-medium ${
              props.recordingIdle ? 'bg-muted text-muted-foreground border' : 'bg-destructive/80 text-white'
            }`}>
            <span
              className={`size-1.5 rounded-full ${props.recordingIdle ? 'bg-muted-foreground' : 'animate-pulse bg-white'}`}
            />
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
            <span
              className={cn('size-1.5 rounded-full bg-current', props.voiceStatus !== 'paused' && 'animate-pulse')}
            />
            {t(VOICE_LABELS[props.voiceStatus as keyof typeof VOICE_LABELS])}
          </button>
        ) : (
          <button
            type="button"
            className={iconButton}
            onClick={props.onVoice}
            aria-label={t('voice_talk', [name])}
            title={t('voice_talk', [name])}>
            <Mic className="size-4" />
          </button>
        )}
        <button
          type="button"
          className={iconButton}
          onClick={props.onNewThread}
          aria-label={t('threads_new')}
          title={t('threads_new')}>
          <SquarePen className="size-4" />
        </button>
      </nav>
    </header>
  );
}
