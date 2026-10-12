/*
 * The live gate: a working copy of the side panel next to a mail page. It runs a short task (the run trail fills
 * node by node), then stops at the amber diamond and the confirm card until the visitor holds the button or stops.
 *
 * Built from the panel's own parts, imported from ../src unchanged: the run trail (ChainOfThought), the thinking
 * orb, the hold button and the panel button, with the composer's own CSS. Two pieces repeat the app's markup:
 * the confirm card, because ConfirmCard takes its labels from chrome.i18n ("Confirm") and the site's direction
 * asks for "Hold to send" and "Stop"; and the composer, which here only ever shows a running task (disabled, with
 * Stop), so the hero doesn't carry the real Composer's dictation code. The real one is in the voice section.
 *
 * The page renders this in its paused state, so without JavaScript it reads as a finished run waiting for a click.
 * With JavaScript (and no reduced-motion preference) the run plays once when the demo comes into view; until then
 * the parts the run draws stay hidden (`data-armed`), so it starts from the moment the request was sent.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowUp,
  Check,
  ChevronRight,
  Disc,
  ListTree,
  Lock,
  Mic,
  Paperclip,
  RotateCcw,
  Square,
  SquarePen,
} from 'lucide-react';
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from '@app/side-panel/components/ai/chain-of-thought';
import type { StepStatus } from '@app/side-panel/components/ai/chain-of-thought';
import { Button } from '@app/side-panel/components/ui/button';
import { HoldButton } from '@app/side-panel/components/ui/hold-button';
import { ThinkingOrb } from '@app/side-panel/components/ui/thinking-orb';
import '@app/side-panel/components/ui/morph-orb.css';
import type { demo } from '../content/site';
import { STEP_ICONS } from '../lib/icons';
import '../styles/demo.css';

type DemoCopy = typeof demo;
type Phase = 'run' | 'paused' | 'sent' | 'stopped';

interface DemoState {
  phase: Phase;
  // Steps started so far in a run; the last of them is the one working
  shown: number;
  // Characters of the reply typed into the page
  typed: number;
  // A stop that came before the gate
  early?: boolean;
}

interface TrailRow {
  key: string;
  icon?: LucideIcon;
  label: ReactNode;
  detail?: string;
  status: StepStatus;
}

// When each step starts, from the start of a run (ms); then how long the typing takes and when the gate holds
const STEP_AT = [800, 1700, 2600, 3250];
const TYPE_MS = 1350;
const HOLD_AT = 4900;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The composer while a task runs, with Composer.tsx's markup and morph-orb.css: the glass pill with its aurora and
 * lit ring, the text box disabled, and Stop in place of Send until the run ends.
 */
function RunningComposer({
  labels,
  busy,
  onStop,
}: {
  labels: DemoCopy['composer'];
  busy: boolean;
  onStop: () => void;
}) {
  const iconButton =
    'flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40';
  return (
    <form aria-label={labels.form} onSubmit={event => event.preventDefault()}>
      <div className="mo-pill">
        <div className="mo-underglow" aria-hidden="true" />
        <div className="mo-surface" aria-hidden="true">
          <div className="mo-aurora">
            <i />
            <i />
            <i />
            <i />
          </div>
        </div>
        <div className="mo-ring" aria-hidden="true" />
        <div className="relative flex flex-col gap-1 p-2">
          <div className="flex items-end gap-1">
            <svg
              className="text-primary mb-2 ml-2 size-[18px] shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true">
              <path d="M10 3.5l1.7 4.8 4.8 1.7-4.8 1.7L10 16.5l-1.7-4.8L3.5 10l4.8-1.7L10 3.5z" />
              <path d="M18 14.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" />
            </svg>
            <textarea
              rows={1}
              disabled
              placeholder={labels.placeholder}
              aria-label={labels.editor}
              className="text-foreground placeholder:text-muted-foreground max-h-[132px] min-h-9 flex-1 resize-none border-0 bg-transparent p-2 text-[14px] leading-5 outline-none disabled:cursor-not-allowed"
            />
            <div className="flex shrink-0 items-center gap-0.5 pb-0.5">
              <button type="button" className={iconButton} disabled aria-label={labels.attach} title={labels.attach}>
                <Paperclip className="size-4" />
              </button>
              {busy ? (
                <button
                  type="button"
                  onClick={onStop}
                  aria-label={labels.stop}
                  title={labels.stop}
                  className="border-destructive/50 bg-destructive/15 text-foreground flex size-[38px] items-center justify-center rounded-full border">
                  <Square className="size-3.5 fill-current" />
                </button>
              ) : (
                <button type="submit" disabled aria-label={labels.send} title={labels.send} className="mo-send">
                  <ArrowUp className="size-[18px]" strokeWidth={1.75} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}

/** The panel's idle presence: the LiveOrb's face, drawn flat (the hero keeps WebGL out of first load). */
function IdleFace() {
  return (
    <svg viewBox="0 0 32 32" className="size-6" aria-hidden="true">
      <circle cx="16" cy="16" r="15" fill="#F4F4F5" />
      <rect x="10" y="10.6" width="2.3" height="7.6" rx="1.15" fill="#09090B" />
      <rect x="19.7" y="10.6" width="2.3" height="7.6" rx="1.15" fill="#09090B" />
    </svg>
  );
}

export default function GateDemo({ copy }: { copy: DemoCopy }) {
  const total = copy.steps.length;
  const draftLength = copy.draft.length;
  const [state, setState] = useState<DemoState>({ phase: 'paused', shown: total, typed: draftLength });
  const [live, setLive] = useState(false);
  // Hydrated and waiting to be seen: the run's parts stay hidden until it plays
  const [armed, setArmed] = useState(false);
  // Each run gets a fresh confirm card (and so a fresh hold button)
  const [runCount, setRunCount] = useState(0);
  const [inView, setInView] = useState(true);
  const [announce, setAnnounce] = useState('');
  const rootRef = useRef<HTMLElement>(null);
  const convoRef = useRef<HTMLDivElement>(null);
  const replayRef = useRef<HTMLButtonElement>(null);
  const timers = useRef<number[]>([]);
  const frame = useRef(0);
  const refocus = useRef(false);

  const clearTimers = useCallback(() => {
    timers.current.forEach(id => window.clearTimeout(id));
    timers.current = [];
    cancelAnimationFrame(frame.current);
  }, []);

  const pause = useCallback(() => {
    setState({ phase: 'paused', shown: total, typed: draftLength });
    setAnnounce(copy.waitingAnnounce);
  }, [copy.waitingAnnounce, draftLength, total]);

  const run = useCallback(() => {
    clearTimers();
    setLive(true);
    // With reduced motion the states change at once: straight to the card
    if (reducedMotion()) {
      pause();
      return;
    }
    setAnnounce('');
    setState({ phase: 'run', shown: 0, typed: 0 });
    setRunCount(count => count + 1);
    STEP_AT.forEach((at, index) => {
      timers.current.push(
        window.setTimeout(() => {
          setState(current => (current.phase === 'run' ? { ...current, shown: index + 1 } : current));
          if (index !== STEP_AT.length - 1) return;
          const start = performance.now();
          const tick = (now: number) => {
            const progress = Math.min(1, (now - start) / TYPE_MS);
            setState(current =>
              current.phase === 'run' ? { ...current, typed: Math.round(progress * draftLength) } : current,
            );
            if (progress < 1) frame.current = requestAnimationFrame(tick);
          };
          frame.current = requestAnimationFrame(tick);
        }, at),
      );
    });
    timers.current.push(window.setTimeout(pause, HOLD_AT));
  }, [clearTimers, draftLength, pause]);

  const finish = useCallback(
    (phase: 'sent' | 'stopped') => {
      clearTimers();
      // The button that had the focus is about to go: hand the focus to "Run it again"
      const active = document.activeElement;
      refocus.current = !!active && active !== document.body && !!rootRef.current?.contains(active);
      setState(current => ({ ...current, phase, early: phase === 'stopped' && current.phase === 'run' }));
      setAnnounce(phase === 'sent' ? copy.sent.announce : copy.stopped.announce);
    },
    [clearTimers, copy.sent.announce, copy.stopped.announce],
  );

  const send = useCallback(() => finish('sent'), [finish]);
  const stop = useCallback(() => finish('stopped'), [finish]);

  // The conversation keeps its newest lines in view, as the panel's does when it runs out of room
  useEffect(() => {
    const convo = convoRef.current;
    if (convo) convo.scrollTop = convo.scrollHeight;
  });

  useEffect(() => {
    if (!refocus.current) return;
    if (state.phase !== 'sent' && state.phase !== 'stopped') return;
    refocus.current = false;
    replayRef.current?.focus();
  }, [state.phase]);

  // The first run starts when the demo comes into view; orbs only spin while it is. With reduced motion it shows
  // the paused state at once.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let decided = false;
    const decide = () => {
      decided = true;
      if (reducedMotion()) setLive(true);
      else run();
    };
    if (reducedMotion()) decide();
    else setArmed(true);
    const observer = new IntersectionObserver(
      ([entry]) => {
        setInView(entry.isIntersecting);
        if (!decided && entry.intersectionRatio >= 0.3) decide();
      },
      { threshold: [0, 0.3] },
    );
    observer.observe(root);
    return () => {
      observer.disconnect();
      clearTimers();
    };
  }, [clearTimers, run]);

  const { phase, shown, typed } = state;
  const running = phase === 'run';
  const held = phase === 'paused';
  const ended = phase === 'sent' || phase === 'stopped';

  // The trail: started steps, then what the click decided
  const rows: TrailRow[] = copy.steps.slice(0, running || phase === 'stopped' ? shown : total).map((step, index) => {
    const active = running && index === shown - 1;
    return {
      key: step.label,
      icon: STEP_ICONS[step.icon],
      label: active ? <span className="mo-lab-t">{step.label}</span> : step.label,
      detail: step.detail,
      status: active ? 'active' : 'complete',
    };
  });
  if (phase === 'sent') {
    copy.sent.steps.forEach(label => rows.push({ key: label, icon: STEP_ICONS.note, label, status: 'complete' }));
  }
  if (phase === 'stopped') {
    (state.early ? copy.stopped.early : copy.stopped.steps).forEach(label =>
      rows.push({ key: label, icon: STEP_ICONS.error, label, status: 'failed' }),
    );
  }
  const count = rows.length + (held ? 1 : 0);

  // What the page shows: the agent's current target is ringed, the commit it waits on is ringed in amber
  const replyOpen = !running || shown >= 3;
  const target = running ? (['read', null, 'reply', 'type'][shown - 1] ?? null) : held ? 'send' : null;
  const draft = running ? copy.draft.slice(0, typed) : copy.draft;
  const typing = running && shown === total && typed < draftLength;

  const keepMenu = (event: MouseEvent) => event.preventDefault();

  return (
    <figure
      ref={rootRef}
      className="gd"
      data-phase={phase}
      data-live={live ? '' : undefined}
      data-armed={armed ? '' : undefined}
      aria-label={copy.label}>
      <div className="gd-window">
        <div className="gd-bar" aria-hidden="true">
          <span className="gd-bar__dots">
            <i />
            <i />
            <i />
          </span>
          <span className="gd-bar__url">
            <Lock className="size-3" strokeWidth={2} />
            <span>{copy.host}</span>
            <span className="gd-bar__path">{copy.path}</span>
          </span>
        </div>

        <div className="gd-page" aria-hidden="true">
          <div className="gd-app">
            <div className="gd-app__top">
              <span className="gd-app__name">Mail</span>
              <span className="gd-app__search">Search mail</span>
            </div>
            <div className="gd-mail">
              <p className="gd-mail__subject">{copy.email.subject}</p>
              <div className="gd-mail__from">
                <span className="gd-avatar">{copy.email.initials}</span>
                <span className="gd-mail__who">
                  <b>{copy.email.from}</b>
                  <small>{copy.email.meta}</small>
                </span>
              </div>
              <div className="gd-mail__body" data-target={target === 'read' ? '' : undefined}>
                {copy.email.body.map(paragraph => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
              {phase === 'sent' ? (
                <div className="gd-sent">
                  <div className="gd-mail__from">
                    <span className="gd-avatar gd-avatar--you">{copy.email.you}</span>
                    <span className="gd-mail__who">
                      <b>{copy.email.you}</b>
                      <small className="gd-sent__label">
                        <Check className="size-3" strokeWidth={2.5} />
                        {copy.email.sentLabel}
                      </small>
                    </span>
                  </div>
                  <p>{copy.draft}</p>
                </div>
              ) : (
                <>
                  <div className="gd-mail__actions">
                    {copy.email.actions.map((action, index) => (
                      <span
                        key={action}
                        className="gd-chip"
                        data-target={index === 0 && target === 'reply' ? '' : undefined}>
                        {action}
                      </span>
                    ))}
                  </div>
                  {replyOpen && (
                    <div className="gd-reply" data-pre="">
                      <p className="gd-reply__to">{copy.email.to}</p>
                      <p className="gd-reply__text" data-target={target === 'type' ? '' : undefined}>
                        {draft}
                        {typing && <span className="gd-caret" />}
                      </p>
                      <div className="gd-reply__foot">
                        <span className="gd-send" data-held={target === 'send' ? '' : undefined}>
                          {copy.email.send}
                        </span>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        <section className="gd-panel aura" aria-label={copy.panelLabel}>
          <div className="gd-head">
            <span className="gd-head__orb" aria-hidden="true">
              {/* Busy: the thinking orb (only drawn while in view); idle: the face */}
              {running || held ? inView && <ThinkingOrb size={30} program={shown <= 1 ? 0 : 1} /> : <IdleFace />}
            </span>
            <span className="gd-head__crumbs">
              <span className="text-muted-foreground px-1">{copy.crumbs[0]}</span>
              <ChevronRight className="text-muted-foreground/70 size-3 shrink-0" aria-hidden="true" />
              <span className="truncate px-1 font-medium tracking-tight">{copy.crumbs[1]}</span>
            </span>
            <span className="gd-head__icons" aria-hidden="true">
              <Disc className="size-4" />
              <Mic className="size-4" />
              <SquarePen className="size-4" />
            </span>
          </div>

          <div className="gd-convo" ref={convoRef}>
            <div className="group is-user ml-auto flex w-full max-w-[85%] flex-col items-end gap-2">
              <div className="bg-secondary flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden rounded-[18px] rounded-br-md border px-3.5 py-2.5 text-[14px] leading-relaxed">
                <p className="whitespace-pre-wrap break-words">{copy.prompt}</p>
              </div>
            </div>

            <ChainOfThought defaultOpen className="gd-trail" data-pre="">
              <ChainOfThoughtHeader icon={<ListTree className="size-4" />}>
                <span className="label-mono">{copy.runSteps.replace('{count}', String(count))}</span>
              </ChainOfThoughtHeader>
              <ChainOfThoughtContent>
                {rows.map((row, index) => (
                  <ChainOfThoughtStep
                    key={row.key}
                    icon={row.icon}
                    status={row.status}
                    label={row.label}
                    description={row.detail}
                    last={index === rows.length - 1 && !held && !running}
                  />
                ))}
                {held && <ChainOfThoughtStep status="held" last label={copy.held} />}
                {running && (
                  <div className="flex items-center gap-2 pl-0.5 pt-1">
                    {inView ? (
                      <ThinkingOrb size={26} program={shown === 0 ? 0 : 1} />
                    ) : (
                      <span className="size-[26px]" />
                    )}
                    <span className="mo-lab-t text-[12.5px]">{shown === 0 ? copy.planning : copy.working}</span>
                  </div>
                )}
              </ChainOfThoughtContent>
            </ChainOfThought>

            {ended && (
              <div className="gd-answer animate-in fade-in-0">
                <p className="text-[14px] leading-relaxed">
                  {phase === 'sent' ? copy.sent.answer : state.early ? copy.stopped.earlyAnswer : copy.stopped.answer}
                </p>
                <Button ref={replayRef} variant="outline" size="sm" onClick={run}>
                  <RotateCcw className="size-3.5" />
                  {copy.replay}
                </Button>
              </div>
            )}
          </div>

          <div className="gd-foot">
            {/* The card's room is kept for the whole run, hidden, so nothing jumps when it appears */}
            {(running || held) && (
              <div
                key={runCount}
                className="gd-card-slot"
                data-shown={held ? '' : undefined}
                aria-hidden={held ? undefined : true}
                data-pre="">
                <div
                  role="group"
                  aria-labelledby="gd-card-title"
                  className="border-hold/45 from-hold/10 to-hold/[0.03] mb-2 rounded-[18px] border bg-gradient-to-b p-3.5 text-[13px] shadow-[0_0_0_4px_rgb(var(--hold-rgb)/0.06),0_12px_30px_rgba(0,0,0,0.35)]">
                  <div className="flex items-start justify-between gap-3">
                    <p id="gd-card-title" className="text-[14px] font-semibold leading-snug">
                      {copy.card.title}
                    </p>
                    <span className="text-muted-foreground mt-0.5 shrink-0 font-mono text-[10.5px]">{copy.host}</span>
                  </div>
                  <dl className="mt-2.5 grid grid-cols-[64px_1fr] gap-y-1">
                    <dt className="text-muted-foreground font-mono text-[10.5px] leading-5">{copy.card.pageLabel}</dt>
                    <dd className="min-w-0 break-words">{copy.card.page}</dd>
                  </dl>
                  <div className="mt-2.5 rounded-xl bg-black/20 p-2.5">
                    {copy.card.fields.map((field, index) => (
                      <div key={field.label} className={index > 0 ? 'mt-2' : ''}>
                        <div className="text-muted-foreground font-mono text-[10.5px]">{field.label}</div>
                        <div className="whitespace-pre-wrap break-words">{field.value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Button variant="glass" size="lg" className="flex-1" onClick={stop}>
                      {copy.card.stop}
                    </Button>
                    {/* A long press must not open the touch menu, or the hold would be cut short */}
                    <span className="flex flex-[1.4]" onContextMenu={keepMenu}>
                      <HoldButton
                        className="w-full touch-none [-webkit-touch-callout:none]"
                        onConfirm={send}
                        armedLabel={copy.card.armed}>
                        {copy.card.hold}
                      </HoldButton>
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-2 text-center text-[11px]">{copy.card.hint}</p>
                </div>
              </div>
            )}
            <RunningComposer labels={copy.composer} busy={running || held} onStop={stop} />
            <p className="text-muted-foreground mt-1.5 text-center text-[10.5px]">{copy.footer}</p>
          </div>

          <p className="sr-only" role="status">
            {announce}
          </p>
        </section>
      </div>
      <figcaption className="gd-caption">{copy.caption}</figcaption>
    </figure>
  );
}
