import { useEffect, useRef } from 'react';
import { cn } from '@extension/ui';
import { createDottedOrb } from './dotted-orb';
import type { DottedOrb } from './dotted-orb';

export interface ThinkingOrbProps {
  /** Side of the canvas in px; the sphere fills about 60% of it. */
  size?: number;
  /** Which light program runs, 0 to 3: each reads as a different kind of work. */
  program?: number;
  /** True once the work is done: the dots sweep to the done colour. */
  done?: boolean;
  className?: string;
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The dotted orb at rest size, spinning while the agent works. Used inline in a chat and in the header.
 */
export function ThinkingOrb({ size = 44, program = 0, done = false, className }: ThinkingOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orbRef = useRef<DottedOrb | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const orb = createDottedOrb(canvas, {
      canvas: size,
      radius: size * 0.3,
      getSpeed: () => 1,
      isReduced: reduced,
      base: [205, 214, 226],
      done: [110, 231, 200],
    });
    orb.P.k = 1;
    orb.P.alpha = 1;
    orb.P.spin = 0.9;
    orb.ensure();
    orbRef.current = orb;
    return () => {
      orb.destroy();
      orbRef.current = null;
    };
  }, [size]);

  useEffect(() => {
    const orb = orbRef.current;
    if (!orb) return;
    orb.P.prog = ((program % 4) + 4) % 4;
    orb.P.sweep = done ? 1 : 0;
    orb.P.floor = done ? 0.9 : 0;
    orb.P.spin = done ? 0.3 : 0.9;
  }, [program, done]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn('shrink-0', className)}
      style={{ width: size, height: size }}
    />
  );
}
