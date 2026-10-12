/*
 * The globe's first frame, drawn at build time by the app's own orb code (createDottedOrb, imported unchanged) into
 * a 2D context that records its dots instead of painting them. The page shows these dots as SVG until the canvas
 * draws the same frame, so the globe is there with JavaScript off and nothing pops in when it starts.
 */
import { createDottedOrb } from '@app/side-panel/components/ui/dotted-orb';

export interface Dot {
  x: number;
  y: number;
  r: number;
  a: number;
}

type Frame = (now: number) => void;

/** The dots of the orb's first frame, in canvas pixels (front half last), for a canvas `size` px wide. */
export function globeDots(size: number, radius: number): Dot[] {
  const dots: Dot[] = [];
  let fill = '';
  let path: { x: number; y: number; r: number } | null = null;
  const context = {
    setTransform() {},
    clearRect() {},
    beginPath() {
      path = null;
    },
    arc(x: number, y: number, r: number) {
      path = { x, y, r };
    },
    fill() {
      if (!path) return;
      const alpha = Number(/,\s*([\d.]+)\)$/.exec(fill)?.[1] ?? 1);
      dots.push({ ...path, a: alpha });
    },
    get fillStyle() {
      return fill;
    },
    set fillStyle(value: string) {
      fill = value;
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;

  // The orb reads the pixel ratio and asks for animation frames: stand in for both, for this one synchronous call
  const scope = globalThis as unknown as Record<string, unknown>;
  const keys = ['window', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
  const had = Object.fromEntries(keys.map(key => [key, key in scope])) as Record<(typeof keys)[number], boolean>;
  const saved = {
    window: scope.window,
    requestAnimationFrame: scope.requestAnimationFrame,
    cancelAnimationFrame: scope.cancelAnimationFrame,
  };
  let next: Frame | null = null;
  scope.window = saved.window ?? { devicePixelRatio: 1 };
  scope.requestAnimationFrame = (callback: Frame) => {
    next = callback;
    return 1;
  };
  scope.cancelAnimationFrame = () => {};
  try {
    const orb = createDottedOrb(canvas, {
      canvas: size,
      radius,
      getSpeed: () => 1,
      isReduced: () => false,
    });
    orb.P.k = 1;
    orb.P.alpha = 1;
    orb.ensure();
    const frame = next as Frame | null;
    next = null;
    frame?.(performance.now());
    orb.destroy();
  } finally {
    for (const key of keys) {
      if (had[key]) scope[key] = saved[key];
      else delete scope[key];
    }
  }
  return dots;
}

/** The dots as SVG circles in `currentColor`, rounded to keep the markup small. */
export function globeSvg(size: number, radius: number): string {
  const round = (value: number, places = 1) => Number(value.toFixed(places));
  const circles = globeDots(size, radius)
    .filter(dot => dot.a > 0.01)
    .map(
      dot =>
        `<circle cx="${round(dot.x)}" cy="${round(dot.y)}" r="${round(dot.r, 2)}" fill-opacity="${round(dot.a, 2)}"/>`,
    )
    .join('');
  return `<svg class="globe__still" viewBox="0 0 ${size} ${size}" fill="currentColor" aria-hidden="true" focusable="false">${circles}</svg>`;
}
