import { useEffect, useState } from 'react';

/**
 * An element's content box, kept current with ResizeObserver. force-graph wants plain CSS pixels.
 *
 * Returns a callback ref rather than a RefObject: GraphView's first render (before its live query
 * resolves) returns the empty-state message instead of the canvas wrapper, so a plain useRef's
 * once-only mount effect would find nothing to observe yet and never get another chance. A callback
 * ref fires again whenever the node it is attached to actually changes, including the later render
 * that swaps the empty state for the real wrapper.
 */
export function useElementSize<T extends HTMLElement>(): [(node: T | null) => void, { width: number; height: number }] {
  const [node, setNode] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!node) return;
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ width: box.width, height: box.height });
    });
    observer.observe(node);
    setSize({ width: node.clientWidth, height: node.clientHeight });
    return () => observer.disconnect();
  }, [node]);

  return [setNode, size];
}

/** Whether the system asks for less motion, kept current if the person changes it while the view is open. */
export function reducedMotionPreferred(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(reducedMotionPreferred);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
