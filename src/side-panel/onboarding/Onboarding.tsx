import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Cpu } from 'lucide-react';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import { checkAssistantName, generalSettingsStore, meetingSettingsStore, onboardingStore } from '@extension/storage';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { LiveOrb } from '../components/ui/live-orb';
import { displayPhrase, useAssistantName, useWakeChoice } from '../hooks/useAssistant';
import { NameInput, WakeNote, nameError } from './AssistantName';
import { setWakeWord } from './wake';

const STEPS = 3;

interface OnboardingProps {
  /** Whether a model is set up; null while the panel is still checking */
  hasModel: boolean | null;
  /** Shows Models & usage in the panel */
  onOpenModels: () => void;
}

/**
 * The first-run setup, shown once over the panel: name the assistant, add a model, and (optionally)
 * turn on the wake word. Skip or Esc ends it at any step; it never shows again either way. Opening
 * Models & usage parks it behind a "Finish setup" pill that brings back the last step.
 */
export default function Onboarding({ hasModel, onOpenModels }: OnboardingProps) {
  // undefined while reading: nothing shows until it is known that setup has not been done
  const [completedAt, setCompletedAt] = useState<number | undefined>(undefined);
  const [step, setStep] = useState(0);
  const [parked, setParked] = useState(false);
  const savedName = useAssistantName();
  const [draft, setDraft] = useState<string | null>(null);
  const [showError, setShowError] = useState(false);
  const [wakeOn, setWakeOn] = useState(false);
  const [wakeError, setWakeError] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  // The dialog's keys (set below, on every render, so it sees the current step)
  const onKey = useRef<(event: KeyboardEvent) => void>(() => {});

  useEffect(() => {
    const read = () => void onboardingStore.get().then(state => setCompletedAt(state?.completedAt ?? 0));
    read();
    return onboardingStore.subscribe(read);
  }, []);

  useEffect(() => {
    void meetingSettingsStore.getSettings().then(settings => setWakeOn(settings.wakeWord));
  }, []);

  // Each step starts with focus on its first control, so the keyboard can go straight on
  useEffect(() => {
    if (step === 0 || parked) return;
    dialog.current?.querySelector<HTMLElement>('[data-autofocus], [role="switch"]')?.focus();
  }, [step, parked]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const listener = (event: KeyboardEvent) => onKey.current(event);
    element.addEventListener('keydown', listener);
    return () => element.removeEventListener('keydown', listener);
  }, [completedAt, parked]);

  const name = draft ?? savedName;
  const nameCheck = checkAssistantName(name);
  const shownName = nameCheck.ok ? nameCheck.name : savedName;
  const wake = useWakeChoice(shownName);

  if (completedAt === undefined || completedAt > 0) return null;

  const finish = () => {
    setCompletedAt(Date.now());
    void onboardingStore.complete();
  };

  const next = async () => {
    if (step === 0) {
      if (!nameCheck.ok) {
        setShowError(true);
        return;
      }
      await generalSettingsStore.updateSettings({ assistantName: nameCheck.name });
      setDraft(nameCheck.name);
    }
    if (step === STEPS - 1) {
      finish();
      return;
    }
    setStep(step + 1);
  };

  const toggleWake = async (on: boolean) => {
    setWakeOn(on);
    setWakeError('');
    setWakeError(await setWakeWord(on));
  };

  if (parked) {
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-24 z-30 flex justify-center">
        <Button
          className="pointer-events-auto shadow-[0_10px_30px_rgba(0,0,0,0.35)]"
          onClick={() => {
            setParked(false);
            setStep(STEPS - 1);
          }}>
          {t('onboard_resume')}
          <ArrowRight className="size-3.5" />
        </Button>
      </div>
    );
  }

  // Esc skips; Enter outside a button goes on; Tab stays inside the dialog
  onKey.current = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish();
      return;
    }
    if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      void next();
      return;
    }
    if (event.key !== 'Tab' || !dialog.current) return;
    const focusable = [
      ...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href]'),
    ];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const titles = ['onboard_name_title', 'onboard_model_title', 'onboard_wake_title'] as const;
  const error = showError ? nameError(name) : '';

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={t('onboard_dialog')}
      aria-describedby="onboard-body"
      className="bg-background/95 animate-in fade-in-0 absolute inset-0 z-30 flex flex-col backdrop-blur-xl">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(360px_300px_at_50%_22%,rgb(var(--primary-rgb)/0.14),transparent_70%)]"
      />
      <div className="relative flex items-center justify-between px-4 pt-4">
        <span className="label-mono" aria-live="polite">
          {t('onboard_step', [String(step + 1), String(STEPS)])}
        </span>
        <Button variant="ghost" size="sm" onClick={finish}>
          {t('onboard_skip')}
        </Button>
      </div>
      <div className="relative flex gap-1.5 px-4 pt-3" aria-hidden="true">
        {Array.from({ length: STEPS }, (_, index) => (
          <span
            key={index}
            className={cn(
              'h-1 flex-1 rounded-full transition-colors duration-200',
              index <= step ? 'bg-primary/70' : 'bg-muted',
            )}
          />
        ))}
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4 pt-8">
        <LiveOrb size={step === 0 ? 88 : 64} label={shownName} className="self-start" />
        <h2 className="text-[22px] font-medium leading-tight tracking-[-0.03em]">{t(titles[step])}</h2>

        {step === 0 && (
          <>
            <p id="onboard-body" className="text-muted-foreground text-[13px] leading-relaxed">
              {t('onboard_name_body')}
            </p>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="onboard-name" className="label-mono">
                {t('onboard_name_field')}
              </label>
              <NameInput
                id="onboard-name"
                errorId="onboard-name-error"
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                value={name}
                onChange={value => {
                  setDraft(value);
                  setShowError(false);
                }}
                onBlur={() => setShowError(true)}
                className="h-10 px-3 text-[15px]"
              />
              {error ? (
                <p id="onboard-name-error" role="alert" className="text-destructive text-[11.5px]">
                  {error}
                </p>
              ) : (
                <WakeNote name={name} />
              )}
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <p id="onboard-body" className="text-muted-foreground text-[13px] leading-relaxed">
              {hasModel ? t('onboard_model_ready') : t('onboard_model_body', [shownName])}
            </p>
            <Button
              data-autofocus
              variant={hasModel ? 'glass' : 'default'}
              className="self-start"
              onClick={() => {
                setParked(true);
                onOpenModels();
              }}>
              <Cpu className="size-3.5" />
              {t('onboard_model_open')}
            </Button>
          </>
        )}

        {step === 2 && (
          <>
            <p id="onboard-body" className="text-muted-foreground text-[13px] leading-relaxed">
              {t('onboard_wake_body', [displayPhrase(wake, shownName)])}
            </p>
            <div className="glass flex items-center gap-3 rounded-2xl px-3 py-2.5">
              <div className="min-w-0 flex-1 text-[13px]">{t('settings_wake', [displayPhrase(wake, shownName)])}</div>
              <Switch
                label={t('settings_wake', [displayPhrase(wake, shownName)])}
                checked={wakeOn}
                onChange={value => void toggleWake(value)}
              />
            </div>
            {wakeError && (
              <p role="alert" className="text-destructive text-[11.5px]">
                {wakeError}
              </p>
            )}
            <WakeNote name={shownName} />
          </>
        )}
      </div>

      <div className="relative flex items-center justify-between gap-2 px-4 pb-6 pt-2">
        {step > 0 ? (
          <Button variant="ghost" onClick={() => setStep(step - 1)}>
            {t('onboard_back')}
          </Button>
        ) : (
          <span />
        )}
        <Button onClick={() => void next()}>
          {step === STEPS - 1 ? t('onboard_done') : t('onboard_next')}
          {step < STEPS - 1 && <ArrowRight className="size-3.5" />}
          <kbd aria-hidden="true" className="text-muted-foreground ml-1 font-mono text-[10px]">
            ↵
          </kbd>
        </Button>
      </div>
    </div>
  );
}
