/*
 * Voice, from the panel's own parts: the LiveOrb (the voice orb, its eyes follow your pointer) and the chat
 * composer in dictation mode. The composer is the real one; only the microphone is simulated: a speech-like level
 * feeds its meter, then the words are "written down" into the box, as the real dictation does.
 * It plays once when it comes into view; with reduced motion it shows the words already written.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@extension/i18n';
import Composer from '@app/side-panel/components/Composer';
import { LiveOrb } from '@app/side-panel/components/ui/live-orb';
import type { home } from '../content/site';
import '../styles/voice.css';

type VoiceCopy = (typeof home)['voice']['stage'];
type SpeechStatus = 'idle' | 'starting' | 'listening' | 'transcribing';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A stand-in for useSpeechInput: the same states and level, without a microphone. */
function useSimulatedSpeech(onWords: () => void) {
  const [status, setStatus] = useState<SpeechStatus>('idle');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const level = useRef(0);
  const statusRef = useRef<SpeechStatus>('idle');
  const timers = useRef<number[]>([]);
  const frame = useRef(0);
  const onWordsRef = useRef(onWords);
  onWordsRef.current = onWords;

  const set = (next: SpeechStatus) => {
    statusRef.current = next;
    setStatus(next);
  };

  const clear = () => {
    timers.current.forEach(id => window.clearTimeout(id));
    timers.current = [];
    cancelAnimationFrame(frame.current);
    level.current = 0;
  };

  // Syllables about four times a second, louder and quieter phrases, a breath between them
  const meter = () => {
    const start = performance.now();
    const tick = (now: number) => {
      const time = (now - start) / 1000;
      const syllable = Math.abs(Math.sin(time * Math.PI * 4.2));
      const phrase = 0.55 + 0.45 * Math.sin(time * 1.3 + 0.6);
      const breath = time % 2.6 > 2.2 ? 0.12 : 1;
      const target = 0.1 + 0.8 * syllable * phrase * breath + Math.random() * 0.06;
      level.current = target > level.current ? target : level.current * 0.85 + target * 0.15;
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  };

  const finish = () => {
    clear();
    set('transcribing');
    timers.current.push(
      window.setTimeout(() => {
        set('idle');
        setStartedAt(null);
        onWordsRef.current();
      }, 900),
    );
  };

  const toggle = useCallback(async () => {
    const current = statusRef.current;
    if (current === 'idle') {
      clear();
      set('starting');
      timers.current.push(
        window.setTimeout(() => {
          set('listening');
          setStartedAt(Date.now());
          meter();
          timers.current.push(window.setTimeout(finish, 3400));
        }, 450),
      );
    } else if (current === 'starting' || current === 'listening') {
      finish();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = useCallback(() => {
    clear();
    set('idle');
    setStartedAt(null);
  }, []);

  useEffect(() => clear, []);
  return { status, startedAt, level, toggle, cancel };
}

export default function VoiceDemo({ copy }: { copy: VoiceCopy }) {
  // The composer's two ways in: the dictation sink (puts the words in and focuses the box, for a dictation the
  // visitor started) and its content setter (no focus, for the one that plays by itself, so the page never jumps)
  const sink = useRef<((words: string) => void) | null>(null);
  const setContent = useRef<((text: string) => void) | null>(null);
  const autoplay = useRef(false);
  const [note, setNote] = useState('');
  const speech = useSimulatedSpeech(() => {
    if (autoplay.current) {
      autoplay.current = false;
      setContent.current?.(copy.words);
    } else sink.current?.(copy.words);
  });
  const cancel = speech.cancel;
  const speechInput = {
    ...speech,
    cancel: () => {
      autoplay.current = false;
      cancel();
    },
  };
  const setTranscriptSink = useCallback((next: (words: string) => void) => {
    sink.current = next;
  }, []);
  const setContentSetter = useCallback((next: (text: string) => void) => {
    setContent.current = next;
  }, []);

  // Hydrated when it scrolls into view: play the dictation once, or show its result at once
  useEffect(() => {
    if (reducedMotion()) {
      const id = window.setTimeout(() => setContent.current?.(copy.words), 0);
      return () => window.clearTimeout(id);
    }
    const id = window.setTimeout(() => {
      autoplay.current = true;
      void speech.toggle();
    }, 700);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const listening = speech.status === 'starting' || speech.status === 'listening';
  const hint = listening ? t('chat_stt_hint') : note || copy.replay;

  return (
    <div className="vd">
      <div className="vd-talk">
        <div className="vd-orb">
          <LiveOrb size={112} label={copy.orbLabel} />
        </div>
        <div className="vd-talk__text">
          <p className="label">{copy.talkLabel}</p>
          <p className="vd-wake">{copy.wake}</p>
          <p className="vd-talk__note">{copy.wakeNote}</p>
        </div>
      </div>
      <div className="vd-dictate">
        <p className="label">{copy.dictateLabel}</p>
        <Composer
          onSendMessage={() => setNote(copy.sentNote)}
          onStopTask={() => {}}
          speech={speechInput}
          setTranscriptSink={setTranscriptSink}
          setContent={setContentSetter}
          disabled={false}
          showStopButton={false}
          placeholder={copy.placeholder}
        />
        <p className="vd-hint">{hint}</p>
      </div>
    </div>
  );
}
