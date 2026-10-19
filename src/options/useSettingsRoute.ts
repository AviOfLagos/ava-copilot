import { useCallback, useEffect, useState } from 'react';
import { parseSettingsHash } from '../side-panel/settings/pages';
import type { SettingsRoute } from '../side-panel/settings/pages';

/**
 * The page and section the address names (`options.html#voice/engines`). Moving sets the hash, so back and forward
 * walk the pages, and a link opened from the panel or by Ava lands where it points.
 */
export function useSettingsRoute(): { route: SettingsRoute; navigate: (hash: string) => void } {
  const [route, setRoute] = useState<SettingsRoute>(() => parseSettingsHash(window.location.hash));

  useEffect(() => {
    const onHash = () => setRoute(parseSettingsHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = useCallback((hash: string) => {
    if (window.location.hash === hash) setRoute(parseSettingsHash(hash));
    else window.location.hash = hash;
  }, []);

  return { route, navigate };
}
