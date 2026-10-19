import { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import { t } from '@extension/i18n';
import { LIVE_VOICES, VOICE_SLOTS, voicesOfSlot } from '@extension/storage';
import type { PersonalityVoices, VoiceSlot } from '@extension/storage';
import { cn } from '@extension/ui';
import type { PanelApi } from '../registry';

type MessageKey = Parameters<typeof t>[0];

const INPUT = 'glass w-full min-w-0 rounded-lg px-2 py-1.5 text-[12.5px] text-foreground outline-none';
const PREVIEW =
  'glass inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[12px] text-foreground transition-colors hover:bg-accent disabled:opacity-50';

export const SLOT_LABEL: Record<VoiceSlot, MessageKey> = {
  live: 'persona_voice_engine_live',
  kitten: 'persona_voice_engine_kitten',
  kokoro: 'persona_voice_engine_kokoro',
  system: 'persona_voice_engine_system',
};

// Gemini's voices with their character, e.g. "Puck · Upbeat"
const LIVE_NOTES = new Map<string, string>(LIVE_VOICES.map(voice => [voice.name, voice.note]));

/** The system voices installed on this computer. */
function useSystemVoices(): string[] {
  const [voices, setVoices] = useState<string[]>([]);
  useEffect(() => {
    try {
      chrome.tts.getVoices(found =>
        setVoices(found.map(voice => voice.voiceName).filter((name): name is string => !!name)),
      );
    } catch {
      setVoices([]);
    }
  }, []);
  return voices;
}

const label = (slot: VoiceSlot, voice: string) =>
  slot === 'live' && LIVE_NOTES.get(voice) ? `${voice} · ${LIVE_NOTES.get(voice)}` : voice;

/**
 * A voice per engine, each with Preview (a short line in that voice, through the engine itself: Gemini's speech
 * model for the Live voices, the local or system voice for the others). An empty choice keeps the voice below it:
 * the Settings voice for a personality, the personality's for an agent (`inherited` shows which).
 */
export default function VoicePicker({
  api,
  voices,
  onChange,
  inheritLabel,
  inherited = {},
  rate,
  speaker,
  idPrefix,
}: {
  api: PanelApi;
  voices: PersonalityVoices;
  onChange: (voices: PersonalityVoices) => void;
  inheritLabel: string;
  inherited?: PersonalityVoices;
  rate?: number;
  // Who the sample line introduces
  speaker: string;
  idPrefix: string;
}) {
  const system = useSystemVoices();
  const [playing, setPlaying] = useState<VoiceSlot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const preview = async (slot: VoiceSlot) => {
    setPlaying(slot);
    setError(null);
    try {
      await api.request(
        {
          type: 'voice_preview',
          engine: slot,
          voice: voices[slot] || inherited[slot] || '',
          ...(rate && rate >= 0.5 && rate <= 2 ? { rate } : {}),
          name: speaker.slice(0, 60),
        },
        60_000,
      );
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setPlaying(null);
    }
  };

  return (
    <div className="flex flex-col gap-1.5" data-voice-picker={idPrefix}>
      {VOICE_SLOTS.map(slot => {
        const value = voices[slot] ?? '';
        const options = slot === 'system' ? system : voicesOfSlot(slot);
        const fromBelow = inherited[slot];
        const id = `${idPrefix}-voice-${slot}`;
        return (
          <div key={slot} className="flex flex-col gap-1">
            <label htmlFor={id} className="text-muted-foreground text-[11.5px]">
              {t(SLOT_LABEL[slot])}
            </label>
            <div className="flex gap-1.5">
              <select
                id={id}
                className={INPUT}
                value={value}
                data-voice-slot={slot}
                onChange={event => onChange({ ...voices, [slot]: event.target.value || undefined })}>
                <option value="">
                  {fromBelow ? `${inheritLabel} (${label(slot, fromBelow.split('|')[0])})` : inheritLabel}
                </option>
                {value && !options.includes(value) && (
                  <option value={value}>{value.includes('|') ? t('persona_voice_several') : value}</option>
                )}
                {options.map(voice => (
                  <option key={voice} value={voice}>
                    {label(slot, voice)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={PREVIEW}
                aria-label={t('persona_voice_preview_label', [t(SLOT_LABEL[slot])])}
                title={t('persona_voice_preview_label', [t(SLOT_LABEL[slot])])}
                disabled={playing !== null}
                data-voice-preview={slot}
                onClick={() => void preview(slot)}>
                <Play className="size-3" aria-hidden />
                <span className={cn(playing === slot && 'animate-pulse')}>
                  {playing === slot ? t('persona_voice_previewing') : t('persona_voice_preview')}
                </span>
              </button>
            </div>
          </div>
        );
      })}
      {error && (
        <p role="alert" className="text-destructive text-[11.5px]">
          {error}
        </p>
      )}
    </div>
  );
}
