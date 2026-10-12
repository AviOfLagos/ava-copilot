/*
 * The globe: the app's dotted orb (createDottedOrb, imported unchanged), large, as the page's 3D object.
 *
 * - Wide screens with motion allowed: fixed to the viewport, it glides (a damped spring on transform only) to the
 *   spot each section names in `data-globe`, and changes light program with the section's `data-state`.
 * - Phones: in the hero, one spot, drawing only while on screen.
 * - Reduced motion: never animated; the build-time SVG frame stays (it is the same first frame).
 * - The tour makes it speak: `speak(level)` swells the dots with the narration's level.
 */
import { createDottedOrb } from '@app/side-panel/components/ui/dotted-orb';
import type { DottedOrb } from '@app/side-panel/components/ui/dotted-orb';

export type GlobeState = 'listening' | 'thinking' | 'acting' | 'done';

interface Spot {
  x: number;
  y: number;
  s: number;
  o: number;
}

interface Params {
  spin: number;
  sweep: number;
  floor: number;
  gain: number;
}

// Light programs (dotted-orb.ts): 0 a chasing pulse, 1 two wandering lights, 2 a band sweeping, 3 a fast chase
const STATES: Record<GlobeState, Params & { prog: number }> = {
  listening: { prog: 2, spin: 0.3, sweep: 0, floor: 0, gain: 1 },
  thinking: { prog: 1, spin: 0.9, sweep: 0, floor: 0, gain: 1 },
  acting: { prog: 0, spin: 0.7, sweep: 0, floor: 0, gain: 1 },
  done: { prog: 1, spin: 0.22, sweep: 1, floor: 0.86, gain: 0.25 },
};

// Dots drawn for each theme: light on graphite, ink on paper; "done" sweeps them to the theme's mint
const COLORS = {
  dark: { base: [214, 221, 233] as [number, number, number], done: [110, 231, 200] as [number, number, number] },
  light: { base: [62, 70, 88] as [number, number, number], done: [13, 148, 122] as [number, number, number] },
};

const FOLLOW = '(min-width: 900px) and (prefers-reduced-motion: no-preference)';
const REDUCED = '(prefers-reduced-motion: reduce)';
// A section takes the globe when it crosses this line, measured from the top of the viewport
const LINE = 0.55;

const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount;

export class Globe {
  private readonly root: HTMLElement;
  // What moves: the root is a clipped layer the size of the viewport while it follows
  private readonly body: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly slot: HTMLElement | null;
  private orb: DottedOrb | null = null;
  private follow = false;
  private visible = true;
  private spotName = 'hero';
  private state: GlobeState = 'listening';
  private pos: Spot = { x: 0, y: 0, s: 1, o: 1 };
  private vel = { x: 0, y: 0, s: 0, o: 0 };
  private params: Params = { ...STATES.listening };
  private level = 0;
  private spinBoost = 0;
  private lastScroll = 0;
  private frame = 0;
  private last = 0;
  private sections: HTMLElement[] = [];
  private active: HTMLElement | null = null;
  private readonly followQuery = window.matchMedia(FOLLOW);
  private readonly reducedQuery = window.matchMedia(REDUCED);

  constructor(root: HTMLElement) {
    this.root = root;
    this.body = root.querySelector<HTMLElement>('[data-globe-body]') ?? root;
    this.canvas = root.querySelector('canvas') as HTMLCanvasElement;
    this.slot = document.querySelector<HTMLElement>('[data-globe-slot]');
    this.sections = Array.from(document.querySelectorAll<HTMLElement>('[data-globe]'));
  }

  start() {
    this.followQuery.addEventListener('change', () => this.configure());
    this.reducedQuery.addEventListener('change', () => this.configure());
    // A new theme needs new dot colours
    new MutationObserver(() => {
      if (this.orb) this.createOrb();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    // Phones: draw only while the globe is on screen
    new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      this.wake();
    }).observe(this.root);
    // The section crossing the line takes the globe
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) this.take(entry.target as HTMLElement);
        }
      },
      { rootMargin: `-${LINE * 100}% 0px -${(1 - LINE) * 100 - 1}% 0px` },
    );
    this.sections.forEach(section => observer.observe(section));
    window.addEventListener('resize', () => this.retarget(false), { passive: true });
    window.addEventListener(
      'scroll',
      () => {
        // Scrolling turns the globe a little faster, as if the page pushed it
        const y = window.scrollY;
        this.spinBoost = Math.min(2.2, this.spinBoost + Math.abs(y - this.lastScroll) * 0.004);
        this.lastScroll = y;
        this.kick();
      },
      { passive: true },
    );
    document.addEventListener('visibilitychange', () => this.wake());
    this.lastScroll = window.scrollY;
    this.configure();
  }

  /** The narration's level, 0 to 1, while the tour speaks; 0 when it stops. */
  speak(level: number) {
    this.level = level;
    this.kick();
  }

  private configure() {
    const reduced = this.reducedQuery.matches;
    const follow = this.followQuery.matches;
    if (reduced) {
      // Still: the SVG frame stays, the canvas goes
      this.destroyOrb();
      this.setFollow(false);
      return;
    }
    if (!this.orb) this.createOrb();
    this.setFollow(follow);
  }

  private createOrb() {
    this.destroyOrb();
    const size = Math.round(this.canvas.clientWidth) || 600;
    const theme = document.documentElement.dataset.theme === 'light' ? COLORS.light : COLORS.dark;
    const orb = createDottedOrb(this.canvas, {
      canvas: size,
      radius: size * 0.38,
      getSpeed: () => 1,
      isReduced: () => false,
      base: theme.base,
      done: theme.done,
    });
    orb.P.k = 1;
    orb.P.alpha = 1;
    this.orb = orb;
    this.apply();
    orb.ensure();
    // The canvas draws the same first frame as the SVG; then the SVG steps aside
    requestAnimationFrame(() => this.root.setAttribute('data-live', ''));
  }

  private destroyOrb() {
    this.orb?.destroy();
    this.orb = null;
    this.root.removeAttribute('data-live');
    this.canvas.getContext('2d')?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private setFollow(follow: boolean) {
    if (follow === this.follow) {
      if (follow) this.retarget(true);
      return;
    }
    this.follow = follow;
    if (follow) {
      this.root.setAttribute('data-follow', '');
      // Start where it is: wherever the active section wants it, without a glide
      this.retarget(true);
    } else {
      this.root.removeAttribute('data-follow');
      this.body.style.transform = '';
      this.body.style.opacity = '';
      this.setState('listening');
    }
    this.wake();
  }

  private take(section: HTMLElement) {
    if (section === this.active) return;
    // The first section seen places the globe at once (a reload mid-page doesn't fly it in from the hero)
    const first = this.active === null;
    this.active = section;
    if (!this.follow) return;
    this.spotName = section.dataset.globe ?? 'hero';
    this.setState((section.dataset.state as GlobeState) ?? 'listening');
    this.retarget(first);
  }

  private setState(state: GlobeState) {
    this.state = state;
    if (this.orb) this.orb.P.prog = STATES[state].prog;
    this.kick();
  }

  /**
   * The height beside the active section's headline, kept within a band of the viewport: the globe comes in level
   * with the words, and stays near the top while the section's widget scrolls past behind it.
   */
  private besideHead(height: number): number {
    const head = this.active?.querySelector<HTMLElement>('.sec__head');
    if (!head) return height * 0.42;
    const box = head.getBoundingClientRect();
    return Math.min(height * 0.62, Math.max(height * 0.3, box.top + box.height / 2));
  }

  /** Where the named spot is now, in viewport pixels, for the globe's centre. */
  private spot(name: string): Spot {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const content = Math.min(1200, width - 64);
    const left = (width - content) / 2;
    const side = Math.min(290, content * 0.21);
    // Below 1100 px the heads keep to the left, so the globe keeps to the right, smaller
    const narrow = width < 1100;
    const named = narrow && (name === 'left' || name === 'right') ? 'right' : name;
    switch (named) {
      case 'hero': {
        const box = this.slot?.getBoundingClientRect();
        if (!box) return { x: width * 0.72, y: height * 0.5, s: 1, o: 1 };
        // The slot's place on the page at the top, held there while the hero is on screen
        return { x: box.left + box.width / 2, y: box.top + window.scrollY + box.height / 2, s: 1, o: 1 };
      }
      case 'right':
        return narrow
          ? { x: left + content - side * 0.75, y: this.besideHead(height), s: 0.5, o: 1 }
          : { x: left + content - side, y: this.besideHead(height), s: 0.62, o: 1 };
      case 'left':
        return { x: left + side, y: this.besideHead(height), s: 0.62, o: 1 };
      case 'peek':
        // Half off the right edge, beside a wide widget
        return { x: width - Math.max(24, left * 0.4), y: this.besideHead(height) - height * 0.08, s: 0.5, o: 1 };
      case 'low':
        // Setting behind the wordmark at the foot
        return { x: width / 2, y: height + 40, s: 0.95, o: 1 };
      case 'away':
        return { x: width + 260, y: height * 0.45, s: 0.5, o: 0 };
      default:
        return { x: left + content - side, y: this.besideHead(height), s: 0.62, o: 1 };
    }
  }

  private target: Spot = { x: 0, y: 0, s: 1, o: 1 };

  private retarget(jump: boolean) {
    if (!this.follow) return;
    if (jump && this.active) {
      this.spotName = this.active.dataset.globe ?? 'hero';
      this.setState((this.active.dataset.state as GlobeState) ?? 'listening');
    }
    this.target = this.spot(this.spotName);
    if (jump) {
      this.pos = { ...this.target };
      this.vel = { x: 0, y: 0, s: 0, o: 0 };
      this.place();
    }
    this.kick();
  }

  private place() {
    const half = (this.canvas.clientWidth || 600) / 2;
    this.body.style.transform = `translate3d(${(this.pos.x - half).toFixed(1)}px, ${(this.pos.y - half).toFixed(1)}px, 0) scale(${this.pos.s.toFixed(4)})`;
    this.body.style.opacity = this.pos.o >= 0.999 ? '' : this.pos.o.toFixed(3);
  }

  /** Pushes the orb's light, spin and size to it, from the section's state and the narration's level. */
  private apply() {
    const orb = this.orb;
    if (!orb) return;
    const level = this.level;
    orb.P.prog = STATES[this.state].prog;
    orb.P.spin = this.params.spin + this.spinBoost + level * 0.6;
    orb.P.sweep = this.params.sweep;
    orb.P.floor = this.params.floor;
    orb.P.gain = this.params.gain + level * 0.9;
    orb.P.pop = 1 + level * 0.07;
    orb.P.rad = level * 0.85;
  }

  /** Starts or stops the orb's own drawing loop: it draws only when it can be seen. */
  private wake() {
    const orb = this.orb;
    if (!orb) return;
    const seen = !document.hidden && (this.follow ? this.pos.o > 0.01 || this.target.o > 0.01 : this.visible);
    if (seen) {
      orb.P.alpha = 1;
      orb.ensure();
    } else {
      // At alpha 0 the orb's loop clears the canvas and stops itself
      orb.P.alpha = 0;
    }
  }

  private kick() {
    if (this.frame) return;
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.frame = 0;
    const dt = Math.min(1 / 30, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    let moving = false;

    if (this.follow) {
      // Spots beside a headline move with the page: look again every frame
      if (this.spotName !== 'hero' && this.spotName !== 'low' && this.spotName !== 'away') {
        this.target = this.spot(this.spotName);
      }
      // A critically damped spring per axis: about a second to settle, no overshoot
      const omega = 5.2;
      for (const key of ['x', 'y', 's', 'o'] as const) {
        const scale = key === 's' || key === 'o' ? 600 : 1;
        const force = omega * omega * (this.target[key] - this.pos[key]) - 2 * omega * this.vel[key];
        this.vel[key] += force * dt;
        this.pos[key] += this.vel[key] * dt;
        if (Math.abs(this.target[key] - this.pos[key]) * scale > 0.3 || Math.abs(this.vel[key]) * scale > 0.3)
          moving = true;
        else {
          this.pos[key] = this.target[key];
          this.vel[key] = 0;
        }
      }
      this.place();
      this.wake();
    }

    // Light and spin ease toward the state's
    const goal = STATES[this.state];
    const ease = 1 - Math.exp(-dt * 3.2);
    for (const key of ['spin', 'sweep', 'floor', 'gain'] as const) {
      this.params[key] = lerp(this.params[key], goal[key], ease);
      if (Math.abs(this.params[key] - goal[key]) > 0.004) moving = true;
      else this.params[key] = goal[key];
    }
    this.spinBoost *= Math.exp(-dt * 2.4);
    if (this.spinBoost > 0.01) moving = true;
    else this.spinBoost = 0;
    if (this.level > 0) moving = true;
    this.apply();
    if (moving) this.frame = requestAnimationFrame(this.tick);
  };
}

export function startGlobe(): Globe | null {
  const root = document.querySelector<HTMLElement>('[data-globe-root]');
  if (!root) return null;
  const globe = new Globe(root);
  globe.start();
  return globe;
}
