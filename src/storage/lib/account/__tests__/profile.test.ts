import { beforeEach, describe, expect, it, vi } from 'vitest';

// base.ts reads globalThis.chrome when it is imported, so the mock must exist before the import
const data = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in values).map(k => [k, values[k]])),
        set: async (items: Record<string, unknown>) => Object.assign(values, items),
        onChanged: { addListener: () => undefined },
      },
    },
  });
  return values;
});

const { accountProfileStore } = await import('../profile');

describe('accountProfileStore', () => {
  beforeEach(() => {
    delete data['account-profile'];
  });

  it('has no name until the user sets one', async () => {
    expect(await accountProfileStore.getDisplayName()).toBe('');
  });

  it('trims and caps a name', async () => {
    await accountProfileStore.setDisplayName('  Avi  ');
    expect(await accountProfileStore.getDisplayName()).toBe('Avi');

    await accountProfileStore.setDisplayName('x'.repeat(100));
    expect((await accountProfileStore.getDisplayName()).length).toBe(60);
  });
});
