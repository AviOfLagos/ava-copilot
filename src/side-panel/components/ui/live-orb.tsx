import { useEffect, useRef, useState } from 'react';
import { cn } from '@extension/ui';

/*
 * Live Orb: an evenly lit WebGL sphere with two capsule eyes that follow the pointer.
 * Shader from the Live Orb component (jay sharma, evilbuttons.com, via 21st.dev), supplied by the user;
 * the render loop, gaze, blink and React wrapper below were written here.
 */

export type LiveOrbVariant = 'white' | 'black' | 'webgl' | 'custom';

export type LiveOrbOptions = {
  /** Material preset. Default `"white"`. */
  variant?: LiveOrbVariant;
  /** Body hex, used when `variant="custom"`. */
  color?: string;
  /** Eye hex, used when `variant="custom"`. */
  eyeColor?: string;
  /** Unlit wash stops, used when `variant="webgl"`. */
  colors?: string[];
  /** Eyes follow the pointer. Default `true`. */
  interactive?: boolean;
  /** Occasional blink. Default `true`. */
  blink?: boolean;
  /** How fast the webgl wash moves. Default 1. */
  speed?: number;
  /** Fires when WebGL is ready (`true`) or torn down (`false`). */
  onHasGl?: (ok: boolean) => void;
};

export type LiveOrbInstance = {
  setOptions: (options: Partial<LiveOrbOptions>) => void;
  destroy: () => void;
};

export const WHITE = { color: '#F4F4F5', eyeColor: '#09090B' } as const;
export const BLACK = { color: '#18181B', eyeColor: '#F4F4F5' } as const;
export const CUSTOM_DEFAULT = { color: '#7C5CFF', eyeColor: '#FAFAFA' } as const;
/** Violet / foam / dust-rose: the stock unlit wash. */
export const WEBGL_COLORS = ['#7C6AF7', '#7DD3C7', '#E8B4D4'];
/** The panel's own wash: mint for acting, periwinkle for calls, a little rose for warmth. */
export const GRAPHITE_COLORS = ['#6EE7C8', '#8C96FF', '#E8B4D4'];

const VERT = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_speed;
uniform vec2 u_look;
uniform float u_blink;
uniform float u_mode;
uniform vec3 u_body;
uniform vec3 u_eye;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_c3;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}

vec3 orient(vec3 p, vec2 look) {
  float yaw = look.x * 0.92;
  float pitch = -look.y * 0.78;
  float cy = cos(yaw);
  float sy = sin(yaw);
  float cp = cos(pitch);
  float sp = sin(pitch);
  vec3 q = vec3(p.x, p.y * cp - p.z * sp, p.y * sp + p.z * cp);
  return vec3(q.x * cy + q.z * sy, q.y, -q.x * sy + q.z * cy);
}

float eyeMask(vec3 n, vec3 e, vec3 right, vec3 up, float halfH, float rad) {
  float facing = dot(n, e);
  float x = dot(n, right) - dot(e, right);
  float y = dot(n, up) - dot(e, up);
  y -= clamp(y, -halfH, halfH);
  float d = length(vec2(x, y)) - rad;
  float fill = 1.0 - smoothstep(-0.01, 0.01, d);
  return fill * smoothstep(0.12, 0.32, facing);
}

vec3 wash(vec3 n, float t) {
  vec2 q = n.xy * 2.2 + n.z * 0.85;
  vec2 w1 = vec2(
    fbm(q * 1.4 + vec2(t * 0.22, t * 0.18)),
    fbm(q * 1.4 + vec2(-t * 0.16, t * 0.24) + 4.1)
  );
  q += (w1 - 0.5) * 0.72;
  float f = fbm(q * 2.1 + vec2(0.0, t * 0.12));
  float g = fbm(q * 4.6 - vec2(t * 0.2, 0.0));
  vec3 col = mix(u_c1, u_c2, smoothstep(0.28, 0.72, f));
  return mix(col, u_c3, pow(smoothstep(0.42, 0.9, g), 1.4));
}

void main() {
  vec2 uv = (gl_FragCoord.xy / u_resolution.xy) * 2.0 - 1.0;
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  uv.x *= aspect;

  float radius = 0.94;
  vec2 p = uv / radius;
  float r2 = dot(p, p);
  float edge = 1.0 - smoothstep(0.985, 1.012, sqrt(max(r2, 0.0)));
  if (edge <= 0.001) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float z = sqrt(max(1.0 - r2, 0.0));
  vec3 n = normalize(vec3(p, z));

  vec2 look = u_look;
  float lm = length(look);
  if (lm > 1.0) look /= lm;

  vec3 right = orient(vec3(1.0, 0.0, 0.0), look);
  vec3 up = orient(vec3(0.0, 1.0, 0.0), look);
  vec3 eL = orient(normalize(vec3(-0.32, 0.08, 1.0)), look);
  vec3 eR = orient(normalize(vec3(0.32, 0.08, 1.0)), look);

  float halfH = mix(0.128, 0.012, u_blink);
  float rad = mix(0.054, 0.062, u_blink);
  float eyes = max(
    eyeMask(n, eL, right, up, halfH, rad),
    eyeMask(n, eR, right, up, halfH, rad)
  );

  vec3 body = u_mode > 0.5 ? wash(n, u_time * u_speed) : u_body;
  vec3 col = mix(body, u_eye, clamp(eyes, 0.0, 1.0));

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), edge);
}
`;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '').trim();
  const full =
    h.length === 3
      ? h
          .split('')
          .map(c => c + c)
          .join('')
      : h.padEnd(6, '0').slice(0, 6);
  const n = Number.parseInt(full, 16);
  if (Number.isNaN(n)) return [0.96, 0.96, 0.96];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('LiveOrb: shader failed to compile', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function resolveVariant(variant: LiveOrbVariant, color?: string, eyeColor?: string, colors?: string[]) {
  let body: string = WHITE.color;
  let eye: string = WHITE.eyeColor;
  let mode = 0;
  let palette: string[] = WEBGL_COLORS;

  if (variant === 'black') {
    body = BLACK.color;
    eye = BLACK.eyeColor;
  } else if (variant === 'webgl') {
    palette = colors && colors.length > 0 ? colors : WEBGL_COLORS;
    body = palette[1] ?? WEBGL_COLORS[1]!;
    eye = '#0C0C10';
    mode = 1;
  } else if (variant === 'custom') {
    body = color ?? CUSTOM_DEFAULT.color;
    eye = eyeColor ?? CUSTOM_DEFAULT.eyeColor;
  }

  return { body, eye, mode, palette };
}

/** What shows when WebGL is not available: a flat disc in the same colours. */
export function fallbackFaceStyle(resolved: ReturnType<typeof resolveVariant>): {
  backgroundColor?: string;
  backgroundImage?: string;
} {
  if (resolved.mode === 1) {
    const [a, b, c] = [0, 1, 2].map(i => resolved.palette[i] ?? WEBGL_COLORS[i]);
    return { backgroundImage: `linear-gradient(135deg, ${a}, ${b}, ${c})` };
  }
  return { backgroundColor: resolved.body };
}

// One blink: eyes close in 70 ms and open in 110 ms
const BLINK_CLOSE_MS = 70;
const BLINK_OPEN_MS = 110;

function blinkAmount(sinceStart: number): number {
  if (sinceStart < 0) return 0;
  if (sinceStart < BLINK_CLOSE_MS) return sinceStart / BLINK_CLOSE_MS;
  const opening = sinceStart - BLINK_CLOSE_MS;
  return opening < BLINK_OPEN_MS ? 1 - opening / BLINK_OPEN_MS : 0;
}

/**
 * Evenly lit sphere with two capsule eyes that follow the pointer.
 * The orb stays put; only the gaze moves.
 */
export function createLiveOrb(canvas: HTMLCanvasElement, initial: LiveOrbOptions = {}): LiveOrbInstance | null {
  let options: LiveOrbOptions & { variant: LiveOrbVariant; interactive: boolean; blink: boolean } = {
    variant: 'white',
    interactive: true,
    blink: true,
    ...initial,
  };

  const look = { x: 0, y: 0.08 };
  const targetLook = { x: 0, y: 0.08 };
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduce = motionQuery.matches;

  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    powerPreference: 'low-power',
  });
  if (!gl) return null;

  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('LiveOrb: program failed to link', gl.getProgramInfoLog(program));
    return null;
  }
  gl.useProgram(program);
  options.onHasGl?.(true);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const uniform = (name: string) => gl.getUniformLocation(program, name);
  const u = {
    resolution: uniform('u_resolution'),
    time: uniform('u_time'),
    speed: uniform('u_speed'),
    look: uniform('u_look'),
    blink: uniform('u_blink'),
    mode: uniform('u_mode'),
    body: uniform('u_body'),
    eye: uniform('u_eye'),
    c1: uniform('u_c1'),
    c2: uniform('u_c2'),
    c3: uniform('u_c3'),
  };

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const applyColors = () => {
    const resolved = resolveVariant(options.variant, options.color, options.eyeColor, options.colors);
    gl.uniform1f(u.mode, resolved.mode);
    gl.uniform3fv(u.body, hexToRgb(resolved.body));
    gl.uniform3fv(u.eye, hexToRgb(resolved.eye));
    gl.uniform3fv(u.c1, hexToRgb(resolved.palette[0] ?? WEBGL_COLORS[0]));
    gl.uniform3fv(u.c2, hexToRgb(resolved.palette[1] ?? WEBGL_COLORS[1]));
    gl.uniform3fv(u.c3, hexToRgb(resolved.palette[2] ?? WEBGL_COLORS[2]));
  };
  applyColors();

  let raf = 0;
  let running = true;
  const start = performance.now();
  let nextBlink = start + 1800 + Math.random() * 2400;
  let blinkAt = -10_000;

  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(u.resolution, canvas.width, canvas.height);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  // The gaze points at the pointer, measured from the orb's centre in orb radii
  const onPointer = (event: PointerEvent) => {
    if (!options.interactive) return;
    const rect = canvas.getBoundingClientRect();
    const radius = Math.max(1, rect.width / 2);
    const dx = (event.clientX - (rect.left + rect.width / 2)) / (radius * 4);
    const dy = (event.clientY - (rect.top + rect.height / 2)) / (radius * 4);
    targetLook.x = Math.max(-1, Math.min(1, dx));
    // Screen y grows downward; the shader's pitch grows upward
    targetLook.y = Math.max(-1, Math.min(1, -dy));
  };
  const onLeave = () => {
    targetLook.x = 0;
    targetLook.y = 0.08;
  };
  const onMotion = (event: MediaQueryListEvent) => {
    reduce = event.matches;
    if (!raf && running) raf = requestAnimationFrame(frame);
  };
  window.addEventListener('pointermove', onPointer, { passive: true });
  document.addEventListener('pointerleave', onLeave);
  motionQuery.addEventListener('change', onMotion);

  const frame = (now: number) => {
    raf = 0;
    if (!running) return;
    // Ease the gaze toward its target
    look.x += (targetLook.x - look.x) * 0.12;
    look.y += (targetLook.y - look.y) * 0.12;

    if (options.blink && !reduce && now >= nextBlink) {
      blinkAt = now;
      nextBlink = now + 2600 + Math.random() * 3600;
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(u.time, reduce ? 4 : (now - start) / 1000);
    gl.uniform1f(u.speed, options.speed ?? 1);
    gl.uniform2f(u.look, look.x, look.y);
    gl.uniform1f(u.blink, blinkAmount(now - blinkAt));
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // A still orb with reduced motion draws once, until something changes
    if (!reduce || Math.abs(targetLook.x - look.x) + Math.abs(targetLook.y - look.y) > 0.002) {
      raf = requestAnimationFrame(frame);
    }
  };
  raf = requestAnimationFrame(frame);

  return {
    setOptions(next) {
      options = { ...options, ...next };
      applyColors();
      if (!raf && running) raf = requestAnimationFrame(frame);
    },
    destroy() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('pointerleave', onLeave);
      motionQuery.removeEventListener('change', onMotion);
      options.onHasGl?.(false);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

export interface LiveOrbProps extends LiveOrbOptions {
  /** Diameter in px. */
  size?: number;
  className?: string;
  /** Accessible name; the orb is decorative when left out. */
  label?: string;
}

/** The Live Orb as a React component, with a flat disc where WebGL is missing. */
export function LiveOrb({
  size = 160,
  className,
  label,
  variant = 'white',
  colors = GRAPHITE_COLORS,
  color,
  eyeColor,
  interactive = true,
  blink = true,
  speed = 1,
}: LiveOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const instanceRef = useRef<LiveOrbInstance | null>(null);
  const [hasGl, setHasGl] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const instance = createLiveOrb(canvas, { variant, colors, color, eyeColor, interactive, blink, speed });
    if (!instance) setHasGl(false);
    instanceRef.current = instance;
    return () => {
      instance?.destroy();
      instanceRef.current = null;
    };
    // Created once; later changes go through setOptions
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    instanceRef.current?.setOptions({ variant, colors, color, eyeColor, interactive, blink, speed });
  }, [variant, colors, color, eyeColor, interactive, blink, speed]);

  const resolved = resolveVariant(variant, color, eyeColor, colors);
  return (
    <div
      className={cn('relative shrink-0', className)}
      style={{ width: size, height: size }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}>
      {hasGl ? (
        <canvas ref={canvasRef} className="size-full" />
      ) : (
        <div className="size-full rounded-full" style={fallbackFaceStyle(resolved)} />
      )}
    </div>
  );
}
