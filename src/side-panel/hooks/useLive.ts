import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';

/**
 * Keeps a database query's result current. Dexie reports changes made anywhere in the extension,
 * including by the background, so the panel shows what the threads do as they do it.
 */
export function useLive<T>(query: () => Promise<T>, deps: unknown[], initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const subscription = liveQuery(query).subscribe({
      next: setValue,
      error: error => console.error('Live query failed', error),
    });
    return () => subscription.unsubscribe();
    // The query closes over the deps; re-subscribing on them is the point
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}
