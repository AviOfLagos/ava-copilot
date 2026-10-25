import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stub = await vi.hoisted(async () => {
  const { installChromeStub } = await import('./chrome-stub');
  return installChromeStub({ manifestVersion: '1.3.0' });
});

vi.mock('@extension/i18n', async () => {
  const { enT } = await import('./en');
  return { t: enT };
});

const GOOD_BODY = {
  version: '1.4.0',
  released: '2026-10-22',
  notes: ['One thing that changed.'],
  extension: { url: 'https://ava.nexprove.com/install.sh', command: 'curl -fsSL https://x | bash' },
  brain: { version: '0.2.0', command: 'cd companion && pnpm install' },
};

const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

const { brainStatusStore } = await import('../../companion/state');
const { updateSettingsStore } = await import('../state');
const { runCheck } = await import('../register');

describe('runCheck', () => {
  beforeEach(async () => {
    stub.local.clear();
    stub.setTitle.calls.length = 0;
    stub.notifications.calls.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('finds an extension update, notifies once, and sets the toolbar tooltip', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse(GOOD_BODY));

    const first = await runCheck();
    expect(first.extensionUpdateAvailable).toBe(true);
    expect(first.info?.version).toBe('1.4.0');
    expect(first.error).toBeNull();
    expect(stub.notifications.calls).toHaveLength(1);
    expect(stub.notifications.calls[0].id).toBe('update:1.4.0');
    expect(stub.setTitle.calls.at(-1)?.title).toContain('update available');

    // A second check that finds the same version again sends no second notification
    const second = await runCheck();
    expect(second.extensionUpdateAvailable).toBe(true);
    expect(stub.notifications.calls).toHaveLength(1);
  });

  it('is up to date when the feed is not newer, and clears the tooltip', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ ...GOOD_BODY, version: '1.3.0' }));
    const status = await runCheck();
    expect(status.extensionUpdateAvailable).toBe(false);
    expect(stub.notifications.calls).toHaveLength(0);
    expect(stub.setTitle.calls.at(-1)?.title).not.toContain('update available');
  });

  it('compares Ava Brain only when a local version is known', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse(GOOD_BODY));

    const unknown = await runCheck();
    expect(unknown.brainUpdateAvailable).toBe(false);
    expect(unknown.brainVersion).toBeNull();

    await brainStatusStore.update({ version: '0.1.0' });
    const known = await runCheck();
    expect(known.brainUpdateAvailable).toBe(true);
    expect(known.brainVersion).toBe('0.1.0');
  });

  it('records a plain error and keeps the previous info when the feed fails', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse(GOOD_BODY));
    await runCheck();

    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    const failed = await runCheck();
    expect(failed.error).not.toBeNull();
    expect(failed.info?.version).toBe('1.4.0');
  });

  it('skips the periodic check when turned off, but "manual" still runs', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse(GOOD_BODY));
    await updateSettingsStore.update({ checkEnabled: false });

    const skipped = await runCheck();
    expect(skipped.checkedAt).toBeNull();

    const manual = await runCheck({ manual: true });
    expect(manual.checkedAt).not.toBeNull();
    expect(manual.extensionUpdateAvailable).toBe(true);
  });
});
