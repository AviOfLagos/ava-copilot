import React, { useLayoutEffect, useRef, useState } from 'react';
import { E, ORB_KEYS, createDottedOrb, lerp, clamp01 } from './dotted-orb';
import type { Ease } from './dotted-orb';
import './morph-orb.css';

/*
 * MorphOrb: the question pill launches into a dotted orb that thinks out loud, then condenses and
 * unfolds into the answer. From the component the user supplied. Changed here: it measures its own
 * box instead of the window (it lives inside the side panel), the answer card grows to fit, the copy
 * comes from props, and it reports its phase so the page can show sources under the answer.
 */

export interface MorphOrbCopy {
  placeholder: string;
  labels: string[];
  done: string;
  answerTitle: string;
  reset: string;
  send: string;
  empty: string;
}

const DEFAULT_COPY: MorphOrbCopy = {
  placeholder: 'Ask anything…',
  labels: ['Thinking', 'Searching', 'Analyzing', 'Composing'],
  done: 'Done',
  answerTitle: 'Answer',
  reset: 'New question',
  send: 'Send',
  empty: 'No answer came back.',
};

export type MorphOrbPhase =
  'idle' | 'launch' | 'assemble' | 'think' | 'resolve' | 'condense' | 'unfold' | 'answered' | 'reset';

export interface MorphOrbProps {
  onSubmit?: (text: string) => Promise<string> | string;
  onPhase?: (phase: MorphOrbPhase) => void;
  minThinkMs?: number;
  speed?: number;
  copy?: Partial<MorphOrbCopy>;
  className?: string;
}

/* ─────────────────────────── geometry ─────────────────────────── */
const PILL_H = 56,
  BALL_SMALL = 56,
  ORB_D = 132,
  ORB_R = 66,
  CANVAS = 220;
const CARD_MIN = 108,
  CARD_MAX = 340;
const FLY_D = 138;
// The pill sits this far above the bottom of the box; the stage centre is at 46% from the top
const PILL_FROM_BOTTOM = 64;

const fmt = (v: number) => String(Math.round(v * 1e4) / 1e4);
const bez = (t: number, p0: number, c: number, p2: number) => (1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * c + t * t * p2;

/* ───────────────────────── timeline data ───────────────────────── */
interface Track {
  ch: string;
  from: number;
  to: number;
  t0: number;
  t1: number;
  ease?: Ease;
}
const T = (ch: string, from: number, to: number, t0: number, t1: number, ease: Ease = E.io): Track => ({
  ch,
  from,
  to,
  t0,
  t1,
  ease,
});

interface Geo {
  pw: number;
  cw: number;
  ch: number;
  H: number;
  dir: number;
}

const launchTracks = (g: Geo): Track[] => [
  T('w', g.pw, g.pw - 12, 0, 100, E.out),
  T('oInput', 1, 0, 0, 160, E.in),
  T('inScale', 1, 0.6, 0, 160, E.in),
  T('oGlow', 1, 0, 0, 300, E.out),
  T('oAur', 1, 0, 0, 300, E.out),
  T('w', g.pw - 12, BALL_SMALL, 100, 560, E.io),
  T('h', PILL_H, PILL_H + 6, 380, 500, E.out),
  T('h', PILL_H + 6, BALL_SMALL, 500, 620, E.out),
  T('oPill', 1, 0, 300, 560, E.out),
  T('oBall', 0, 1, 300, 560, E.out),
  T('u', 0, 1, 620, 1500, E.fly),
  T('w', BALL_SMALL, FLY_D, 620, 1300, E.grow),
  T('h', BALL_SMALL, FLY_D, 620, 1300, E.grow),
  T('w', FLY_D, ORB_D, 1300, 1500, E.out),
  T('h', FLY_D, ORB_D, 1300, 1500, E.out),
  T('cHalo', 0, 0.6, 620, 1500, E.out),
  T('trail', 0, 1, 700, 800, E.out),
  T('trail', 1, 0, 1300, 1500, E.in),
];

const ASSEMBLE: Track[] = [
  T('oRing', 1, 0, 0, 300, E.out),
  T('oBall', 1, 0, 0, 260, E.out),
  T('orb.k', 0, 1, 0, 800, E.out),
  T('orb.alpha', 0, 1, 0, 800, E.out),
  T('orb.spin', 0, 0.9, 0, 800, E.out),
  T('orb.pop', 1, 1.05, 0, 420, E.out),
  T('orb.pop', 1.05, 1, 420, 800, E.io),
  T('sOp', 0, 1, 300, 620, E.out),
  T('sTy', 6, 0, 300, 620, E.out),
];

const RESOLVE: Track[] = [
  T('orb.sweep', 0, 1, 0, 700, E.io),
  T('orb.spin', 0.9, 0.3, 0, 700, E.out),
  T('orb.gain', 1, 0, 0, 700, E.out),
  T('orb.floor', 0, 0.95, 400, 900, E.out),
  T('orb.rad', 0, 0.15, 400, 900, E.out),
  T('orb.pop', 1, 1.04, 600, 800, E.out),
  T('orb.pop', 1.04, 1, 800, 900, E.out),
];

const CONDENSE: Track[] = [
  T('orb.pop', 1, 1.06, 0, 120, E.out),
  T('sOp', 1, 0, 0, 160, E.in),
  T('sTy', 0, -6, 0, 160, E.in),
  T('orb.k', 1, 0, 120, 640, E.vortex),
  T('orb.vortex', 0, 1.6, 120, 640, E.vortex),
  T('oGreen', 0, 1, 260, 700, E.spring),
  T('gs', 0.55, 1, 260, 700, E.spring),
  T('pulse', 0, 1, 320, 760, E.out),
  T('oHalo', 0, 0.35, 380, 700, E.out),
  T('orb.alpha', 1, 0, 500, 800, E.out),
];

const unfoldTracks = (g: Geo, tw: number): Track[] => [
  T('w', ORB_D, 124, 0, 90, E.in),
  T('h', ORB_D, 124, 0, 90, E.in),
  T('w', 124, g.cw, 90, 700, E.card),
  T('h', 124, g.ch, 90, 700, E.out),
  T('r', ORB_D / 2, 20, 90, 700, E.io),
  T('oGreen', 1, 0, 200, 560, E.out),
  T('oCard', 0, 1, 200, 560, E.out),
  T('oHalo', 0.35, 0, 300, 700, E.out),
  T('cHalo', 0.6, 0.22, 300, 700, E.out),
  T('hOp', 0, 1, 520, 840, E.out),
  T('dotS', 0, 1, 520, 840, E.spring),
  T('wp', 0, 1, 600, 600 + tw, E.lin),
  T('bloom', 1, 0.625, 700, 1200, E.io),
];

// Reduced motion: cross-fades only
const R_OUT: Track[] = [
  T('oInput', 1, 0, 0, 140, E.out),
  T('oPill', 1, 0, 0, 200, E.out),
  T('oGlow', 1, 0, 0, 200, E.out),
  T('oAur', 1, 0, 0, 200, E.out),
  T('oRing', 1, 0, 0, 200, E.out),
];
const R_IN: Track[] = [
  T('orb.alpha', 0, 1, 0, 200, E.out),
  T('sOp', 0, 1, 0, 200, E.out),
  T('cHalo', 0, 0.6, 0, 200, E.out),
];
const R_RESOLVE: Track[] = [T('orb.sweep', 0, 1, 0, 250, E.io), T('orb.floor', 0, 0.95, 0, 250, E.out)];
const R_CONDENSE: Track[] = [
  T('oGreen', 0, 1, 0, 250, E.out),
  T('orb.alpha', 1, 0, 0, 250, E.out),
  T('sOp', 1, 0, 0, 250, E.out),
];
const R_GREEN_OUT: Track[] = [T('oGreen', 1, 0, 0, 120, E.out)];
const rCardIn = (tw: number): Track[] => [
  T('oCard', 0, 1, 0, 250, E.out),
  T('hOp', 0, 1, 0, 250, E.out),
  T('wp', 0, 1, 0, tw, E.lin),
  T('bloom', 1, 0.625, 0, 250, E.out),
];

const FADE = [
  'oGlow',
  'oAur',
  'oPill',
  'oBall',
  'oGreen',
  'oCard',
  'oRing',
  'oInput',
  'oHalo',
  'sOp',
  'orb.alpha',
  'trail',
];

const INIT: Record<string, number> = {
  h: PILL_H,
  r: 999,
  oGlow: 1,
  oHalo: 0,
  oPill: 1,
  oBall: 0,
  oGreen: 0,
  oCard: 0,
  oRing: 1,
  oInput: 1,
  inScale: 1,
  oAur: 1,
  gs: 0.55,
  cs: 1,
  hOp: 0,
  dotS: 0,
  bloom: 1,
  u: 0,
  yOff: 0,
  trail: 0,
  pulse: -1,
  sOp: 0,
  sTy: 6,
  cHalo: 0,
  wp: 0,
  'orb.k': 0,
  'orb.alpha': 0,
  'orb.spin': 0,
  'orb.pop': 1,
  'orb.sweep': 0,
  'orb.vortex': 0,
  'orb.gain': 1,
  'orb.floor': 0,
  'orb.rad': 0,
};

/* ─────────────────────────── async utils ─────────────────────────── */
const ABORT = Symbol('abort');

function sleep(ms: number, sig: AbortSignal) {
  return new Promise<void>(res => {
    if (sig.aborted) return res();
    let id = 0;
    const onAbort = () => {
      window.clearTimeout(id);
      res();
    };
    id = window.setTimeout(
      () => {
        sig.removeEventListener('abort', onAbort);
        res();
      },
      Math.max(0, ms),
    );
    sig.addEventListener('abort', onAbort, { once: true });
  });
}

function abortable<V>(p: Promise<V>, sig: AbortSignal) {
  return new Promise<V | undefined>(res => {
    if (sig.aborted) return res(undefined);
    const onAbort = () => res(undefined);
    sig.addEventListener('abort', onAbort, { once: true });
    p.then(
      v => {
        sig.removeEventListener('abort', onAbort);
        res(v);
      },
      () => {
        sig.removeEventListener('abort', onAbort);
        res(undefined);
      },
    );
  });
}

/* ───────────────────────────── runtime ───────────────────────────── */
interface UI {
  setPhase(p: MorphOrbPhase): void;
  swapLabel(name: string): void;
  resetLabel(): void;
  setAnswer(s: string): void;
  clearInput(): void;
  live(s: string): void;
  lock(on: boolean): void;
  idleReady(): void;
  focusAnswer(): void;
}
interface Env {
  root: HTMLElement;
  mover: HTMLElement;
  actor: HTMLElement;
  form: HTMLElement;
  ghosts: HTMLElement[];
  canvas: HTMLCanvasElement;
  pulse: HTMLElement;
  status: HTMLElement;
  getBody: () => HTMLElement | null;
  getCopy: () => MorphOrbCopy;
  ui: UI;
  getSpeed: () => number;
  isReduced: () => boolean;
}
interface RunCfg {
  onSubmit: (text: string) => Promise<string> | string;
  minThink: number;
}
interface Runtime {
  start(text: string, cfg: RunCfg): boolean;
  escape(): void;
  reset(): void;
  hard(): void;
  home(): void;
  busy(): boolean;
  destroy(): void;
}
interface Sample {
  t: number;
  x: number;
  y: number;
  d: number;
}

function sampleAt(h: Sample[], t: number, out: Sample) {
  const n = h.length;
  const copy = (s: Sample) => {
    out.x = s.x;
    out.y = s.y;
    out.d = s.d;
  };
  if (n === 0) {
    out.x = 0;
    out.y = 0;
    out.d = 0;
    return;
  }
  if (t <= h[0].t) return copy(h[0]);
  for (let i = n - 1; i > 0; i--) {
    const a = h[i - 1],
      b = h[i];
    if (t >= a.t) {
      if (t >= b.t) return copy(b);
      const k = (t - a.t) / (b.t - a.t || 1);
      out.x = lerp(a.x, b.x, k);
      out.y = lerp(a.y, b.y, k);
      out.d = lerp(a.d, b.d, k);
      return;
    }
  }
  copy(h[n - 1]);
}

function createRuntime(env: Env): Runtime {
  const { actor, mover, root, status, pulse, ghosts, form } = env;
  const life = new AbortController();
  // Sizes come from the component's own box, not the window
  const pillW = () => Math.min(560, root.clientWidth - 24);
  const cardW = () => Math.min(380, root.clientWidth - 24);
  const homeDy = () => root.clientHeight * 0.54 - PILL_FROM_BOTTOM;
  const geo: Geo = { pw: pillW(), cw: cardW(), ch: CARD_MIN, H: homeDy(), dir: -1 };
  const orb = createDottedOrb(env.canvas, {
    canvas: CANVAS,
    radius: ORB_R,
    getSpeed: env.getSpeed,
    isReduced: env.isReduced,
    base: [225, 230, 238],
    done: [110, 231, 200],
  });
  const vals: Record<string, number> = {};
  const dirty = new Set<string>();
  const CH: Record<string, (v: number) => void> = {};

  let current: AbortController | null = null;
  let idleCtl: AbortController | null = null;
  let busy = false,
    idling = false,
    epoch = 0;
  let curX = 0,
    curY = 0,
    curD = BALL_SMALL,
    trailVis = 0,
    ghostsShown = false;
  let wStagger = 45,
    wDur = 320;
  const hist: Sample[] = [];
  const tmp: Sample = { t: 0, x: 0, y: 0, d: 0 };

  const remeasure = () => {
    geo.pw = pillW();
    geo.cw = cardW();
    geo.H = homeDy();
  };

  const child = () => {
    const ac = new AbortController();
    if (life.signal.aborted) ac.abort();
    else life.signal.addEventListener('abort', () => ac.abort(), { once: true });
    return ac;
  };

  /* flight path and comet trail */
  const renderTrail = () => {
    if (trailVis <= 0.001) {
      if (ghostsShown) {
        ghosts.forEach(g => (g.style.opacity = '0'));
        ghostsShown = false;
      }
      return;
    }
    ghostsShown = true;
    const now = performance.now();
    for (let i = 0; i < ghosts.length; i++) {
      sampleAt(hist, now - (i + 1) * 45, tmp);
      const k = (tmp.d * (1 - 0.08 * (i + 1))) / 100;
      const g = ghosts[i];
      g.style.transform = `translate3d(${(tmp.x - curX).toFixed(2)}px,${(tmp.y - curY).toFixed(2)}px,0) translate(-50%,-50%) scale(${k.toFixed(3)})`;
      g.style.opacity = (0.28 * Math.pow(1 - i / 6, 1.5) * trailVis).toFixed(3);
    }
  };

  const applyPath = () => {
    const u = vals.u ?? 0,
      H = geo.H;
    curX = bez(u, 0, geo.dir * 0.3 * H, 0);
    curY = bez(u, H, 0.6 * H, 0) + (vals.yOff ?? 0);
    mover.style.transform = `translate3d(${curX.toFixed(2)}px,${curY.toFixed(2)}px,0)`;
    const now = performance.now();
    hist.push({ t: now, x: curX, y: curY, d: curD });
    while (hist.length > 2 && hist[0].t < now - 500) hist.shift();
    renderTrail();
  };

  /* answer words */
  const applyWords = (v: number) => {
    const body = env.getBody();
    if (!body) return;
    const nodes = body.querySelectorAll<HTMLElement>('.mo-w');
    const total = (nodes.length - 1) * wStagger + wDur;
    const time = v * total;
    const reduced = env.isReduced();
    nodes.forEach((el, i) => {
      const p = E.out(clamp01((time - i * wStagger) / wDur));
      el.style.opacity = fmt(p);
      el.style.transform = p >= 0.999 || reduced ? 'none' : `translateY(${fmt((1 - p) * 4)}px)`;
      el.style.filter = p >= 0.999 || reduced ? 'none' : `blur(${fmt((1 - p) * 4)}px)`;
    });
  };

  /* channels */
  [
    'oGlow',
    'oHalo',
    'oPill',
    'oBall',
    'oGreen',
    'oCard',
    'oRing',
    'oInput',
    'oAur',
    'gs',
    'cs',
    'hOp',
    'dotS',
    'bloom',
  ].forEach(n => {
    CH[n] = v => actor.style.setProperty('--' + n, fmt(v));
  });
  ['w', 'h', 'r'].forEach(n => {
    CH[n] = v => {
      actor.style.setProperty('--' + n, fmt(v) + 'px');
      if (n === 'w') curD = v;
    };
  });
  CH.inScale = v => {
    actor.style.setProperty('--inScale', fmt(v));
    form.style.filter = v >= 0.999 ? 'none' : `blur(${fmt((1 - v) * 15)}px)`;
  };
  CH.sOp = v => status.style.setProperty('--sOp', fmt(v));
  CH.sTy = v => status.style.setProperty('--sTy', fmt(v) + 'px');
  CH.cHalo = v => root.style.setProperty('--oCenter', fmt(v));
  CH.u = () => applyPath();
  CH.yOff = () => applyPath();
  CH.trail = v => {
    trailVis = v;
    renderTrail();
  };
  CH.pulse = v => {
    if (v < 0) {
      pulse.style.opacity = '0';
      return;
    }
    pulse.style.opacity = fmt(0.5 * (1 - v));
    pulse.style.transform = `scale(${fmt(1 + v)})`;
  };
  CH.wp = applyWords;
  ORB_KEYS.forEach(name => {
    CH['orb.' + name] = v => {
      orb.P[name] = v;
      if (name === 'alpha') orb.ensure();
    };
  });

  const set = (ch: string, v: number) => {
    vals[ch] = v;
    dirty.add(ch);
  };
  const flush = () => {
    dirty.forEach(ch => CH[ch]?.(vals[ch]));
    dirty.clear();
  };
  const setNow = (ch: string, v: number) => {
    vals[ch] = v;
    CH[ch]?.(v);
  };
  const resetChannels = () => {
    setNow('w', geo.pw);
    for (const ch of Object.keys(INIT)) setNow(ch, INIT[ch]);
  };

  /* timeline engine */
  const play = (tracks: Track[], sig: AbortSignal) =>
    new Promise<void>(res => {
      if (sig.aborted) return res();
      const end = tracks.reduce((m, k) => Math.max(m, k.t1), 0);
      const done = new Set<Track>();
      let raf = 0,
        t = 0,
        last = performance.now();
      const onAbort = () => {
        cancelAnimationFrame(raf);
        res();
      };
      const finish = () => {
        sig.removeEventListener('abort', onAbort);
        res();
      };
      const step = (now: number) => {
        const dt = Math.max(0, Math.min(100, now - last));
        last = now;
        t += dt * env.getSpeed();
        for (const k of tracks) {
          if (done.has(k) || t < k.t0) continue;
          const p = Math.min(1, (t - k.t0) / Math.max(1, k.t1 - k.t0));
          set(k.ch, k.from + (k.to - k.from) * (k.ease ?? E.io)(p));
          if (p === 1) done.add(k);
        }
        flush();
        if (t >= end) finish();
        else raf = requestAnimationFrame(step);
      };
      sig.addEventListener('abort', onAbort, { once: true });
      raf = requestAnimationFrame(step);
    });

  /* thinking labels */
  const labelLoop = async (sig: AbortSignal, ctl: { stop: boolean }) => {
    let i = 0;
    const labels = env.getCopy().labels;
    for (;;) {
      await sleep(1150 / env.getSpeed(), sig);
      if (sig.aborted || ctl.stop) return;
      i = (i + 1) % labels.length;
      orb.P.prog = i % 4;
      env.ui.swapLabel(labels[i]);
    }
  };

  // The card is as tall as its text needs, within limits; longer answers scroll inside it
  const cardHeight = (text: string) => {
    const charsPerLine = Math.max(20, Math.floor((geo.cw - 36) / 7.4));
    const lines = Math.ceil(text.length / charsPerLine) + 1;
    return Math.max(CARD_MIN, Math.min(CARD_MAX, 52 + lines * 21));
  };

  /* orchestrator */
  const run = async (text: string, sig: AbortSignal, cfg: RunCfg) => {
    const reduced = env.isReduced();
    const copy = env.getCopy();
    const go = async (tracks: Track[]) => {
      await play(tracks, sig);
      if (sig.aborted) throw ABORT;
    };
    try {
      env.ui.setPhase('launch');
      hist.length = 0;
      if (!reduced) {
        await go(launchTracks(geo));
        setNow('r', ORB_D / 2);
        env.ui.setPhase('assemble');
        await go(ASSEMBLE);
      } else {
        await go(R_OUT);
        setNow('u', 1);
        setNow('w', ORB_D);
        setNow('h', ORB_D);
        setNow('r', ORB_D / 2);
        setNow('sTy', 0);
        setNow('orb.k', 1);
        setNow('orb.spin', 0);
        env.ui.setPhase('assemble');
        await go(R_IN);
      }

      // Think until the answer is in and the minimum time has passed
      env.ui.setPhase('think');
      env.ui.live(copy.labels[0]);
      const ctl = { stop: false };
      void labelLoop(sig, ctl);
      const t0 = performance.now();
      const pending = Promise.resolve()
        .then(() => cfg.onSubmit(text))
        .then(
          b => (typeof b === 'string' && b.trim() ? b : copy.empty),
          (error: unknown) => (error instanceof Error ? error.message : copy.empty),
        );
      const got = await abortable(pending, sig);
      if (sig.aborted) throw ABORT;
      const body = got ?? copy.empty;
      await sleep(cfg.minThink / env.getSpeed() - (performance.now() - t0), sig);
      ctl.stop = true;
      if (sig.aborted) throw ABORT;

      const words = body.split(/\s+/).filter(Boolean);
      const n = Math.max(1, words.length);
      geo.ch = cardHeight(body);

      if (!reduced) {
        env.ui.setPhase('resolve');
        env.ui.swapLabel(copy.done);
        await go(RESOLVE);

        env.ui.setPhase('condense');
        await go(CONDENSE);

        env.ui.setPhase('unfold');
        wDur = 320;
        wStagger = n > 1 ? Math.min(45, 280 / (n - 1)) : 0;
        env.ui.setAnswer(body);
        await go(unfoldTracks(geo, (n - 1) * wStagger + wDur));
      } else {
        env.ui.setPhase('resolve');
        env.ui.swapLabel(copy.done);
        await go(R_RESOLVE);
        await sleep(350 / env.getSpeed(), sig);
        if (sig.aborted) throw ABORT;

        env.ui.setPhase('condense');
        setNow('gs', 1);
        await go(R_CONDENSE);

        env.ui.setPhase('unfold');
        wDur = 250;
        wStagger = 0;
        env.ui.setAnswer(body);
        await go(R_GREEN_OUT);
        setNow('w', geo.cw);
        setNow('h', geo.ch);
        setNow('r', 20);
        setNow('dotS', 1);
        await go(rCardIn(wDur));
      }

      env.ui.setPhase('answered');
      env.ui.live('Answer ready: ' + body);
      env.ui.focusAnswer();
    } catch (e) {
      if (e === ABORT) return;
      hard();
    }
  };

  /* back to the idle pill */
  const toIdle = async (kind: 'reset' | 'esc') => {
    if (idling) return;
    idling = true;
    const my = ++epoch;
    const ac = child();
    idleCtl = ac;
    const sig = ac.signal;
    const outMs = kind === 'reset' ? 240 : 200;
    const inMs = kind === 'reset' ? 420 : 200;
    env.ui.setPhase('reset');

    const out: Track[] = [T('cHalo', vals.cHalo ?? 0, 0, 0, outMs, E.out)];
    for (const ch of FADE) {
      const v = vals[ch] ?? 0;
      if (v > 0.001) out.push(T(ch, v, 0, 0, outMs, E.out));
    }
    if (kind === 'reset') out.push(T('cs', 1, 0.98, 0, outMs, E.out));
    await play(out, sig);
    if (sig.aborted || my !== epoch) return;

    setNow('pulse', -1);
    env.ui.setAnswer('');
    env.ui.resetLabel();
    env.ui.clearInput();
    orb.reset();
    hist.length = 0;
    remeasure();
    resetChannels();
    const pillCh = ['oPill', 'oInput', 'oGlow', 'oAur', 'oRing'];
    pillCh.forEach(ch => setNow(ch, 0));
    setNow('yOff', kind === 'reset' ? 8 : 0);
    const inn: Track[] = pillCh.map(ch => T(ch, 0, 1, 0, inMs, E.out));
    if (kind === 'reset') inn.push(T('yOff', 8, 0, 0, inMs, E.out));
    await play(inn, sig);
    if (sig.aborted || my !== epoch) return;

    resetChannels();
    current = null;
    idleCtl = null;
    busy = false;
    idling = false;
    env.ui.lock(false);
    env.ui.setPhase('idle');
    env.ui.idleReady();
  };

  function hard() {
    epoch++;
    current?.abort();
    current = null;
    idleCtl?.abort();
    idleCtl = null;
    orb.reset();
    hist.length = 0;
    env.ui.setAnswer('');
    env.ui.resetLabel();
    remeasure();
    resetChannels();
    setNow('pulse', -1);
    busy = false;
    idling = false;
    env.ui.lock(false);
    env.ui.setPhase('idle');
    env.ui.idleReady();
  }

  resetChannels();

  return {
    start(text, cfg) {
      if (busy) return false;
      busy = true;
      // Measure once per run, never in frames
      remeasure();
      geo.dir = -geo.dir;
      orb.reset();
      setNow('u', 0);
      const ac = child();
      current = ac;
      env.ui.lock(true);
      void run(text, ac.signal, cfg);
      return true;
    },
    escape() {
      if (!busy || idling) return;
      current?.abort();
      void toIdle('esc');
    },
    reset() {
      if (!busy || idling) return;
      void toIdle('reset');
    },
    hard,
    home() {
      if (busy) return;
      remeasure();
      setNow('w', geo.pw);
      setNow('u', 0);
    },
    busy: () => busy,
    destroy() {
      life.abort();
      orb.destroy();
    },
  };
}

/* ───────────────────────────── component ───────────────────────────── */
export default function MorphOrb(props: MorphOrbProps) {
  const copyRef = useRef<MorphOrbCopy>({ ...DEFAULT_COPY, ...props.copy });
  copyRef.current = { ...DEFAULT_COPY, ...props.copy };
  const COPY = copyRef.current;

  const [phase, setPhaseState] = useState<MorphOrbPhase>('idle');
  const [value, setValue] = useState('');
  const [lbl, setLbl] = useState<{ cur: string; prev: string | null; n: number }>({
    cur: COPY.labels[0],
    prev: null,
    n: 0,
  });
  const [answer, setAnswer] = useState('');

  const rootRef = useRef<HTMLDivElement>(null);
  const moverRef = useRef<HTMLDivElement>(null);
  const actorRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pulseRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const answerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const ghostRefs = useRef<(HTMLSpanElement | null)[]>([]);

  const propsRef = useRef(props);
  propsRef.current = props;
  const speedRef = useRef(1);
  speedRef.current = Math.max(0.05, props.speed ?? 1);
  const phaseRef = useRef<MorphOrbPhase>('idle');
  const reducedRef = useRef(false);
  const rtRef = useRef<Runtime | null>(null);
  const timers = useRef<{ typing?: number; shake?: number; flash?: number }>({});

  useLayoutEffect(() => {
    const root = rootRef.current,
      mover = moverRef.current,
      actor = actorRef.current,
      canvas = canvasRef.current;
    const pulse = pulseRef.current,
      status = statusRef.current,
      form = formRef.current;
    const ghosts = ghostRefs.current.filter((g): g is HTMLSpanElement => !!g);
    if (!root || !mover || !actor || !canvas || !pulse || !status || !form) return;

    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedRef.current = mq.matches;
    const onMq = (e: MediaQueryListEvent) => {
      reducedRef.current = e.matches;
    };
    mq.addEventListener('change', onMq);

    const rt = createRuntime({
      root,
      mover,
      actor,
      form,
      ghosts,
      canvas,
      pulse,
      status,
      getBody: () => bodyRef.current,
      getCopy: () => copyRef.current,
      getSpeed: () => speedRef.current,
      isReduced: () => reducedRef.current,
      ui: {
        setPhase: p => {
          phaseRef.current = p;
          setPhaseState(p);
          propsRef.current.onPhase?.(p);
        },
        swapLabel: name => setLbl(l => (l.cur === name ? l : { cur: name, prev: l.cur, n: l.n + 1 })),
        resetLabel: () => setLbl(l => ({ cur: copyRef.current.labels[0], prev: null, n: l.n + 1 })),
        setAnswer: s => setAnswer(s),
        clearInput: () => setValue(''),
        live: s => {
          if (liveRef.current) liveRef.current.textContent = s;
        },
        lock: on => {
          form.toggleAttribute('inert', on);
        },
        idleReady: () => {
          inputRef.current?.focus({ preventScroll: true });
        },
        focusAnswer: () => {
          answerRef.current?.focus({ preventScroll: true });
        },
      },
    });
    rtRef.current = rt;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phaseRef.current !== 'idle' && phaseRef.current !== 'reset') {
        e.preventDefault();
        rt.escape();
      }
    };
    // The panel can be resized or popped out; an idle pill follows its box
    const observer = new ResizeObserver(() => {
      if (phaseRef.current === 'idle' && !rt.busy()) rt.home();
    });
    observer.observe(root);
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
      observer.disconnect();
      mq.removeEventListener('change', onMq);
      window.clearTimeout(timers.current.typing);
      window.clearTimeout(timers.current.shake);
      window.clearTimeout(timers.current.flash);
      rt.destroy();
      rtRef.current = null;
    };
  }, []);

  const makeCfg = (): RunCfg => ({
    onSubmit: propsRef.current.onSubmit ?? (() => copyRef.current.empty),
    minThink: propsRef.current.minThinkMs ?? 1800,
  });

  const shake = () => {
    const a = actorRef.current;
    if (!a) return;
    a.removeAttribute('data-shake');
    void a.offsetWidth;
    a.setAttribute('data-shake', '');
    a.setAttribute('data-flash', '');
    window.clearTimeout(timers.current.shake);
    window.clearTimeout(timers.current.flash);
    timers.current.shake = window.setTimeout(() => a.removeAttribute('data-shake'), 260);
    timers.current.flash = window.setTimeout(() => a.removeAttribute('data-flash'), 200);
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value);
    const a = actorRef.current;
    if (!a) return;
    a.setAttribute('data-typing', '');
    window.clearTimeout(timers.current.typing);
    timers.current.typing = window.setTimeout(() => a.removeAttribute('data-typing'), 300);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && (e.shiftKey || e.nativeEvent.isComposing)) e.preventDefault();
  };

  const onFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const rt = rtRef.current;
    if (!rt || rt.busy() || phaseRef.current !== 'idle') return;
    const text = value.trim();
    if (!text) {
      shake();
      return;
    }
    rt.start(text, makeCfg());
  };

  const onReset = () => {
    if (phaseRef.current === 'answered') rtRef.current?.reset();
  };

  const ready = value.trim().length > 0;
  const words = answer.split(/\s+/).filter(Boolean);

  const labelInner = (name: string) =>
    name === COPY.done ? (
      <span className="mo-lab-done">{name}</span>
    ) : (
      <>
        <span className="mo-lab-t">{name}</span>
        <span className="mo-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </>
    );

  return (
    <div className={`mo-root ${props.className ?? ''}`} data-phase={phase} ref={rootRef}>
      <div className="mo-halo" aria-hidden="true" />

      <div className="mo-mover" ref={moverRef}>
        {Array.from({ length: 6 }).map((_, i) => (
          <span
            key={i}
            className="mo-trail"
            aria-hidden="true"
            ref={el => {
              ghostRefs.current[i] = el;
            }}
          />
        ))}

        <div className="mo-actor" ref={actorRef}>
          <div className="mo-underglow" aria-hidden="true" />
          <div className="mo-halo-green" aria-hidden="true" />
          <div className="mo-surface" aria-hidden="true">
            <div className="mo-aurora">
              <i />
              <i />
              <i />
              <i />
            </div>
          </div>
          <div className="mo-ball" aria-hidden="true" />
          <div className="mo-green" aria-hidden="true" />
          <div className="mo-card" aria-hidden="true" />
          <div className="mo-ring" aria-hidden="true" />

          <form className="mo-input" ref={formRef} onSubmit={onFormSubmit} autoComplete="off">
            <svg
              className="mo-spark"
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
            <input
              ref={inputRef}
              className="mo-field"
              type="text"
              value={value}
              maxLength={500}
              placeholder={COPY.placeholder}
              aria-label={COPY.placeholder}
              spellCheck={false}
              onChange={onChange}
              onKeyDown={onKeyDown}
            />
            <button type="submit" className="mo-send" aria-label={COPY.send} data-ready={ready ? '' : undefined}>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true">
                <path d="M12 19V5" />
                <path d="M5.5 11.5L12 5l6.5 6.5" />
              </svg>
            </button>
          </form>

          <canvas className="mo-orb" ref={canvasRef} aria-hidden="true" />
          <div className="mo-pulse" ref={pulseRef} aria-hidden="true" />

          <div className="mo-answer" ref={answerRef} tabIndex={-1} role="group" aria-label={COPY.answerTitle}>
            <div className="mo-a-head">
              <i className="mo-a-dot" aria-hidden="true" />
              <span>{COPY.answerTitle}</span>
            </div>
            <p className="mo-a-body" ref={bodyRef}>
              {words.map((w, i) => (
                <React.Fragment key={i}>
                  <span className="mo-w">{w}</span>{' '}
                </React.Fragment>
              ))}
            </p>
          </div>
        </div>
      </div>

      <div className="mo-status" ref={statusRef} aria-hidden="true">
        {lbl.prev !== null && (
          <span key={'p' + lbl.n} className="mo-lab mo-out">
            {labelInner(lbl.prev)}
          </span>
        )}
        <span key={'c' + lbl.n} className="mo-lab mo-in">
          {labelInner(lbl.cur)}
        </span>
      </div>

      <button type="button" className="mo-reset" onClick={onReset}>
        {COPY.reset}
      </button>

      <div className="mo-live" ref={liveRef} role="status" aria-live="polite" />
    </div>
  );
}
