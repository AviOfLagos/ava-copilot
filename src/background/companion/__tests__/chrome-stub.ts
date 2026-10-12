/**
 * A small chrome.storage (local and session, with onChanged) for the companion's tests. Install it from
 * vi.hoisted, before the modules that create their stores are imported.
 */
export function installChromeStub(): { local: Map<string, unknown>; session: Map<string, unknown> } {
  const areas = { local: new Map<string, unknown>(), session: new Map<string, unknown>() };
  const area = (map: Map<string, unknown>) => ({
    get: async (keys?: string | string[]) => {
      const list = keys === undefined ? [...map.keys()] : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(key => map.has(key)).map(key => [key, map.get(key)]));
    },
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) map.set(key, structuredClone(value));
    },
    remove: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) map.delete(key);
    },
    onChanged: { addListener: () => {} },
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: area(areas.local), session: area(areas.session), onChanged: { addListener: () => {} } },
    runtime: { id: 'test' },
  };
  return areas;
}
