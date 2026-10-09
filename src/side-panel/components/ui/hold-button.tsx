import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@extension/ui';

export const HOLD_MS = 800;
// After a plain click, a second click within this time confirms
const ARM_MS = 4000;

interface HoldButtonProps {
  onConfirm: () => void;
  children: ReactNode;
  /** Shown after a plain click, until the second click or the time runs out. */
  armedLabel: ReactNode;
  className?: string;
}

/**
 * The button for anything that sends, posts or deletes: hold it for 0.8 s, or click it twice. The
 * friction is the point, and the second click keeps it usable from a keyboard or a screen reader.
 */
export function HoldButton({ onConfirm, children, armedLabel, className }: HoldButtonProps) {
  const [progress, setProgress] = useState(0);
  const [armed, setArmed] = useState(false);
  const raf = useRef(0);
  const started = useRef(0);
  const firedByHold = useRef(false);
  const armTimer = useRef(0);

  const stop = () => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    setProgress(0);
  };

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      window.clearTimeout(armTimer.current);
    },
    [],
  );

  const tick = (now: number) => {
    const p = Math.min(1, (now - started.current) / HOLD_MS);
    setProgress(p);
    if (p >= 1) {
      raf.current = 0;
      firedByHold.current = true;
      onConfirm();
      return;
    }
    raf.current = requestAnimationFrame(tick);
  };

  const begin = () => {
    if (raf.current) return;
    firedByHold.current = false;
    started.current = performance.now();
    raf.current = requestAnimationFrame(tick);
  };

  const onClick = () => {
    // The click that ends a completed hold is not a second click
    if (firedByHold.current) {
      firedByHold.current = false;
      return;
    }
    if (armed) {
      window.clearTimeout(armTimer.current);
      setArmed(false);
      onConfirm();
      return;
    }
    setArmed(true);
    window.clearTimeout(armTimer.current);
    armTimer.current = window.setTimeout(() => setArmed(false), ARM_MS);
  };

  return (
    <button
      type="button"
      onPointerDown={begin}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={event => {
        if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) begin();
      }}
      onKeyUp={event => {
        if (event.key === 'Enter' || event.key === ' ') stop();
      }}
      onClick={onClick}
      className={cn(
        'relative flex h-10 select-none items-center justify-center gap-2 overflow-hidden rounded-xl border border-hold bg-hold/15 px-4 text-[13px] font-semibold text-hold-foreground transition-colors hover:bg-hold/20',
        armed && 'bg-hold/30',
        className,
      )}>
      <span
        aria-hidden="true"
        className="from-hold/60 to-hold/30 absolute inset-y-0 left-0 bg-gradient-to-r"
        style={{ width: `${progress * 100}%` }}
      />
      <span className="relative">{armed ? armedLabel : children}</span>
    </button>
  );
}
