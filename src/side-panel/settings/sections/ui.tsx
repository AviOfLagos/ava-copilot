import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

// The small parts every settings section is made of, so the full page and the panel look the same

export const SELECT =
  'rounded-lg border bg-card px-2 py-1 text-[12px] text-foreground outline-none focus:border-primary/50';
export const NUMBER =
  'bg-card focus:border-primary/50 w-20 rounded-lg border px-2 py-1 text-right font-mono text-[12.5px] text-foreground outline-none';
export const HINT = 'text-muted-foreground text-[11.5px]';

export function Row({
  title,
  hint,
  htmlFor,
  children,
}: {
  title: string;
  hint?: ReactNode;
  // The control the title labels, when it is a form field
  htmlFor?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-[13px]">
            {title}
          </label>
        ) : (
          <div className="text-[13px]">{title}</div>
        )}
        {hint && <div className="text-muted-foreground mt-0.5 text-[11.5px]">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

interface Store<T> {
  getSettings: () => Promise<T>;
  subscribe: (listener: () => void) => () => void;
}

/** A settings store's value, kept current when another page changes it. */
export function useStoreSettings<T>(store: Store<T>): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => void store.getSettings().then(next => alive && setValue(next));
    load();
    const stop = store.subscribe(load);
    return () => {
      alive = false;
      stop();
    };
  }, [store]);
  return value;
}
