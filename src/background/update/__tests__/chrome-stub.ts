/**
 * A small chrome surface for this feature's tests: storage (local/session), a fake manifest version, the
 * toolbar title and notifications as spies, and no-op listeners for the startup hooks register.ts adds at
 * import time. Install it from vi.hoisted, before the modules that create stores or register listeners import.
 */
export function installChromeStub(options: { manifestVersion?: string } = {}): {
  local: Map<string, unknown>;
  session: Map<string, unknown>;
  setTitle: { calls: { title: string }[] };
  notifications: { calls: { id: string; options: Record<string, unknown> }[] };
} {
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

  const setTitle = { calls: [] as { title: string }[] };
  const notifications = { calls: [] as { id: string; options: Record<string, unknown> }[] };

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: area(areas.local), session: area(areas.session), onChanged: { addListener: () => {} } },
    runtime: {
      id: 'test',
      getManifest: () => ({ version: options.manifestVersion ?? '1.0.0' }),
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
    },
    action: {
      setTitle: async (arg: { title: string }) => {
        setTitle.calls.push(arg);
      },
    },
    notifications: {
      create: async (id: string, notificationOptions: Record<string, unknown>) => {
        notifications.calls.push({ id, options: notificationOptions });
      },
      onButtonClicked: { addListener: () => {} },
      onClicked: { addListener: () => {} },
    },
    alarms: {
      get: async () => undefined,
      create: async () => {},
      onAlarm: { addListener: () => {} },
    },
  };
  return { ...areas, setTitle, notifications };
}
