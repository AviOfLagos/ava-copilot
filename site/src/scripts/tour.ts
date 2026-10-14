/*
 * Ava's tour. Nothing plays, and no recording is requested, before the visitor presses "Listen to the tour".
 * After that, each section's line plays as the section reaches the middle of the screen: one at a time, a new
 * section fading the last line out after a short settle, lines already heard not repeating. The line shows as a
 * caption in the dock, with Pause and Stop; the globe speaks to the audio's level (an AnalyserNode). A hidden tab
 * pauses it, and it resumes on return. Esc stops it. Without the recordings it still shows the words.
 */
import type { Globe } from './globe';

interface Line {
  id: string;
  n: string;
  label: string;
  text: string;
  file: string | null;
  seconds: number;
}

interface TourCopy {
  pause: string;
  resume: string;
  waiting: string;
  ended: string;
  failed: string;
  announce: Record<'started' | 'paused' | 'resumed' | 'stopped' | 'ended', string>;
}

type Phase = 'off' | 'playing' | 'paused' | 'waiting';

// The line the tour plays is the section crossing this height of the viewport (the globe's line, too)
const LINE = 0.55;
const SETTLE_MS = 420;
// Switching lines: the old one fades out and stops, then the new one fades in, so two never play at once
const FADE_OUT_MS = 200;
const FADE_IN_MS = 100;

export function startTour(globe: Globe | null) {
  const data = document.getElementById('tour-data');
  const dock = document.querySelector<HTMLElement>('[data-tour-dock]');
  if (!data || !dock) return;
  const { lines, copy } = JSON.parse(data.textContent ?? '{}') as { lines: Line[]; copy: TourCopy };
  const byId = new Map(lines.map(line => [line.id, line]));
  const caption = dock.querySelector<HTMLElement>('[data-tour-caption]')!;
  const label = dock.querySelector<HTMLElement>('[data-tour-label]')!;
  const pauseButton = dock.querySelector<HTMLButtonElement>('[data-tour-pause]')!;
  const pauseLabel = pauseButton.querySelector<HTMLElement>('[data-label]')!;
  const stopButton = dock.querySelector<HTMLButtonElement>('[data-tour-stop]')!;
  // Outside the dock, so it is heard while the dock is hidden too
  const status = document.querySelector<HTMLElement>('[data-tour-status]')!;
  const starters = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-tour-start]'));
  const sections = Array.from(document.querySelectorAll<HTMLElement>('[data-say]'));
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  let phase: Phase = 'off';
  let current: Line | null = null;
  let audio: HTMLAudioElement | null = null;
  let source: MediaElementAudioSourceNode | null = null;
  let context: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let samples: Uint8Array<ArrayBuffer> | null = null;
  let activeId: string | null = null;
  let settle = 0;
  let textTimer = 0;
  // Each line's own volume in the audio graph: an element's volume is ignored once Web Audio plays it
  const gains = new WeakMap<HTMLAudioElement, GainNode>();
  // Lines still fading out; a newer switch stops them at once
  const fading = new Set<() => void>();
  // Only the latest request to play wins: a fast scroll can ask for several lines in a row
  let request = 0;
  let meter = 0;
  let level = 0;
  let autoPaused = false;
  const heard = new Set<string>();
  const prefetched = new Map<string, HTMLAudioElement>();

  const say = (text: string) => {
    status.textContent = '';
    window.setTimeout(() => (status.textContent = text), 40);
  };

  const mark = (id: string | null) => {
    sections.forEach(section => section.toggleAttribute('data-speaking', !!id && section.dataset.say === id));
  };

  const setPhase = (next: Phase) => {
    phase = next;
    dock.dataset.phase = next;
    document.documentElement.toggleAttribute('data-touring', next !== 'off');
    starters.forEach(button => button.setAttribute('aria-expanded', String(next !== 'off')));
    const paused = next === 'paused';
    pauseButton.setAttribute('aria-pressed', String(paused));
    pauseLabel.textContent = paused ? copy.resume : copy.pause;
  };

  const showLine = (line: Line, note?: string) => {
    label.textContent = `${line.n} · ${line.label}`;
    caption.textContent = note ? `${line.text} (${note})` : line.text;
    dock.toggleAttribute('data-idle', false);
  };

  // ─── Level → globe ───────────────────────────────────────────────────────────────────────────────────────────

  const stopMeter = () => {
    cancelAnimationFrame(meter);
    meter = 0;
    level = 0;
    dock.style.setProperty('--level', '0');
    globe?.speak(0);
  };

  const runMeter = () => {
    if (meter) return;
    const tick = () => {
      meter = 0;
      if (!analyser || !samples || phase !== 'playing') {
        stopMeter();
        return;
      }
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) {
        const centred = (value - 128) / 128;
        sum += centred * centred;
      }
      const rms = Math.sqrt(sum / samples.length);
      // Quick to rise, slower to fall, like a voice meter
      const target = Math.min(1, rms * 4.2);
      level = target > level ? level * 0.45 + target * 0.55 : level * 0.86 + target * 0.14;
      // Reduced motion: the words and the voice, but nothing that moves with it (the bars hold half height)
      if (reduced.matches) {
        dock.style.setProperty('--level', '0.5');
      } else {
        dock.style.setProperty('--level', level.toFixed(3));
        globe?.speak(level);
      }
      meter = requestAnimationFrame(tick);
    };
    meter = requestAnimationFrame(tick);
  };

  // ─── Audio ───────────────────────────────────────────────────────────────────────────────────────────────────

  const ensureContext = () => {
    if (context) return;
    try {
      context = new AudioContext();
      analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.connect(context.destination);
      samples = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    } catch {
      // No Web Audio: the lines still play, the globe just doesn't move with them
      context = null;
      analyser = null;
    }
  };

  const element = (line: Line) => {
    const ready = prefetched.get(line.id);
    if (ready) {
      prefetched.delete(line.id);
      return ready;
    }
    const next = new Audio();
    next.preload = 'auto';
    next.src = line.file ?? '';
    return next;
  };

  // The next line not heard yet starts loading while this one plays
  const prefetch = (after: Line) => {
    const index = lines.indexOf(after);
    const next = lines.slice(index + 1).find(line => !heard.has(line.id) && line.file && !prefetched.has(line.id));
    if (!next?.file) return;
    const early = new Audio();
    early.preload = 'auto';
    early.src = next.file;
    prefetched.set(next.id, early);
  };

  /** Fades the playing line out and stops it; resolves once it is silent. Without `fade`, stops at once. */
  const release = (fade: boolean): Promise<void> => {
    window.clearTimeout(textTimer);
    // Anything still fading from an earlier switch stops now: never more than one voice
    fading.forEach(stopNow => stopNow());
    const old = audio;
    const oldSource = source;
    audio = null;
    source = null;
    if (!old) return Promise.resolve();
    old.onended = null;
    old.onerror = null;
    const gain = gains.get(old);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      fading.delete(finish);
      old.pause();
      gain?.disconnect();
      oldSource?.disconnect();
    };
    if (!fade || old.paused) {
      finish();
      return Promise.resolve();
    }
    fading.add(finish);
    if (gain && context) {
      const now = context.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + FADE_OUT_MS / 1000);
    } else {
      const start = performance.now();
      const from = old.volume;
      const step = (time: number) => {
        if (done) return;
        const progress = Math.min(1, (time - start) / FADE_OUT_MS);
        old.volume = from * (1 - progress);
        if (progress < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    return new Promise(resolve =>
      window.setTimeout(() => {
        finish();
        resolve();
      }, FADE_OUT_MS),
    );
  };

  /** Brings a line in from silence. */
  const fadeIn = (element: HTMLAudioElement) => {
    const gain = gains.get(element);
    if (gain && context) {
      const now = context.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(1, now + FADE_IN_MS / 1000);
      return;
    }
    element.volume = 0;
    const start = performance.now();
    const step = (time: number) => {
      const progress = Math.min(1, (time - start) / FADE_IN_MS);
      element.volume = progress;
      if (progress < 1 && audio === element) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  const finished = (line: Line) => {
    heard.add(line.id);
    stopMeter();
    mark(null);
    if (line.id === lines[lines.length - 1]?.id) {
      end();
      return;
    }
    setPhase('waiting');
    caption.textContent = copy.waiting;
    dock.toggleAttribute('data-idle', true);
    // The section in view may already be the next one
    if (activeId && activeId !== line.id && !heard.has(activeId)) schedule(activeId);
  };

  const play = async (id: string) => {
    const line = byId.get(id);
    if (!line) return;
    const mine = ++request;
    await release(true);
    // A newer section asked while this one waited for the fade: it plays instead
    if (mine !== request) return;
    current = line;
    showLine(line);
    mark(line.id);
    setPhase('playing');
    if (!line.file) {
      // No recording for this line: show the words for as long as they would take to say
      showLine(line, copy.failed);
      textTimer = window.setTimeout(() => finished(line), Math.max(4000, line.seconds * 1000));
      return;
    }
    const next = element(line);
    audio = next;
    if (context && analyser) {
      try {
        source = context.createMediaElementSource(next);
        const gain = context.createGain();
        gain.gain.value = 0;
        source.connect(gain).connect(analyser);
        gains.set(next, gain);
      } catch {
        source = null;
      }
    }
    next.onended = () => {
      if (audio === next) finished(line);
    };
    next.onerror = () => {
      if (audio !== next) return;
      showLine(line, copy.failed);
      textTimer = window.setTimeout(() => finished(line), Math.max(4000, line.seconds * 1000));
    };
    void context?.resume();
    fadeIn(next);
    next.play().then(
      () => {
        if (audio === next && phase === 'playing') runMeter();
      },
      () => {
        // Refused (no click this session, or a decoding error): the words stay on screen
        if (audio !== next) return;
        showLine(line, copy.failed);
        textTimer = window.setTimeout(() => finished(line), Math.max(4000, line.seconds * 1000));
      },
    );
    prefetch(line);
  };

  // A new section plays after it has held the line for a moment, so a fast scroll doesn't stutter
  const schedule = (id: string) => {
    window.clearTimeout(settle);
    settle = window.setTimeout(() => {
      if (phase === 'off' || phase === 'paused') return;
      if (activeId !== id || heard.has(id) || current?.id === id) return;
      void play(id);
    }, SETTLE_MS);
  };

  // ─── Controls ────────────────────────────────────────────────────────────────────────────────────────────────

  const begin = () => {
    ensureContext();
    heard.clear();
    dock.hidden = false;
    // The section in view when the tour starts plays first; the hero if none is
    void play(activeId && byId.has(activeId) ? activeId : lines[0].id);
    say(copy.announce.started);
  };

  const pause = (auto = false) => {
    if (phase === 'off' || phase === 'paused') return;
    // A line still waiting for the previous one to fade out doesn't start
    request++;
    autoPaused = auto;
    window.clearTimeout(settle);
    window.clearTimeout(textTimer);
    audio?.pause();
    stopMeter();
    setPhase('paused');
    if (!auto) say(copy.announce.paused);
  };

  const resume = () => {
    if (phase !== 'paused') return;
    autoPaused = false;
    const moved = activeId && activeId !== current?.id && byId.has(activeId) && !heard.has(activeId);
    if (moved && activeId) {
      void play(activeId);
    } else if (audio && current && !heard.has(current.id)) {
      setPhase('playing');
      mark(current.id);
      void context?.resume();
      audio.play().then(runMeter, () => undefined);
    } else {
      setPhase('waiting');
    }
    say(copy.announce.resumed);
  };

  const stop = (announceIt = true) => {
    window.clearTimeout(settle);
    request++;
    release(false);
    prefetched.clear();
    stopMeter();
    mark(null);
    current = null;
    setPhase('off');
    dock.hidden = true;
    if (announceIt) say(copy.announce.stopped);
    // The focus was in the dock: give it back to the button that started the tour
    if (dock.contains(document.activeElement)) starters[0]?.focus();
  };

  function end() {
    setPhase('waiting');
    caption.textContent = copy.ended;
    label.textContent = '';
    say(copy.announce.ended);
    window.setTimeout(() => {
      if (phase === 'waiting' && caption.textContent === copy.ended) stop(false);
    }, 3200);
  }

  starters.forEach(button =>
    button.addEventListener('click', () => {
      if (phase === 'off') begin();
      else {
        // Pressed again while it plays: from this section
        heard.clear();
        void play(activeId && byId.has(activeId) ? activeId : lines[0].id);
      }
    }),
  );
  pauseButton.addEventListener('click', () => (phase === 'paused' ? resume() : pause()));
  stopButton.addEventListener('click', () => stop());
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && phase !== 'off' && !event.defaultPrevented) stop();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && phase === 'playing') pause(true);
    else if (!document.hidden && autoPaused) resume();
  });

  // ─── Which section is in view ────────────────────────────────────────────────────────────────────────────────

  const observer = new IntersectionObserver(
    entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = (entry.target as HTMLElement).dataset.say ?? null;
        if (!id || id === activeId) continue;
        activeId = id;
        if (phase === 'off' || phase === 'paused') continue;
        if (heard.has(id) || current?.id === id) continue;
        schedule(id);
      }
    },
    { rootMargin: `-${LINE * 100}% 0px -${(1 - LINE) * 100 - 1}% 0px` },
  );
  sections.forEach(section => observer.observe(section));
}
