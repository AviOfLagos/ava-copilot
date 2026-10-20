import { createHash } from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_HOSTS_RULE,
  guardedFetch,
  hardenLaunch,
  installFetchGuard,
  installNetworkGuard,
  lookupAllowed,
  requestUrlOf,
  VENDORED_PATCHES,
  VENDORED_PATCHES_SHA256,
  verdictFor,
} from '../whatsapp/harden';
import { hardenedDriverClass } from '../whatsapp/openwa';

const passThrough = () => {
  const calls: string[] = [];
  const original = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return new Response('from the network');
  }) as typeof fetch;
  return { calls, original };
};

describe('open-wa never gets code or answers from its own hosts', () => {
  it('serves the pinned patch set for every patches address, refuses the rest of open-wa, passes others', () => {
    expect(verdictFor('https://cdn.openwa.dev/patches.json?wv=2.3&wav=5.6.6')).toBe('patches');
    expect(verdictFor('https://raw.githubusercontent.com/open-wa/wa-automate-nodejs/master/patches.json?v=1')).toBe(
      'patches',
    );
    expect(verdictFor('https://funcs.openwa.dev/license-check')).toBe('blocked');
    expect(verdictFor('https://sticker-api.openwa.dev/x')).toBe('blocked');
    expect(verdictFor('https://link.openwa.cloud/api')).toBe('blocked');
    expect(verdictFor('https://raw.githubusercontent.com/open-wa/wa-automate-nodejs/master/anything.js')).toBe(
      'blocked',
    );
    expect(verdictFor('https://api.github.com/repos/open-wa/wa-automate-nodejs/releases')).toBe('blocked');
    expect(verdictFor('https://crashlogs.whatsapp.net/wa_clb_data')).toBe('blocked');
    expect(verdictFor('https://evil.openwa.dev.example.com/patches.json')).toBe('allowed');
    expect(verdictFor('https://raw.githubusercontent.com/someone/else/main/patches.json')).toBe('allowed');
    expect(verdictFor('https://api.openai.com/v1/chat')).toBe('allowed');
    expect(verdictFor(new URL('https://cdn.openwa.dev/patches.json'))).toBe('patches');
    expect(verdictFor({ url: 'https://funcs.openwa.dev/license-check' })).toBe('blocked');
  });

  it('answers with the vendored set, never touching the network for open-wa', async () => {
    expect(createHash('sha256').update(VENDORED_PATCHES).digest('hex')).toBe(VENDORED_PATCHES_SHA256);
    const { calls, original } = passThrough();
    const guarded = guardedFetch(original);
    const patches = await guarded('https://cdn.openwa.dev/patches.json?wv=1');
    expect(patches.headers.get('content-type')).toContain('application/json');
    expect(await patches.json()).toEqual([]);
    await expect(guarded('https://funcs.openwa.dev/license-check', { method: 'POST' })).rejects.toThrow(/Blocked/);
    expect(calls).toEqual([]);
    expect(await (await guarded('https://api.openai.com/v1/models')).text()).toBe('from the network');
    expect(calls).toEqual(['https://api.openai.com/v1/models']);
  });

  it('fails closed when the vendored set does not match its pin', async () => {
    const { calls, original } = passThrough();
    const guarded = guardedFetch(original, { body: '["window.evil()"]', sha256: VENDORED_PATCHES_SHA256 });
    await expect(guarded('https://cdn.openwa.dev/patches.json')).rejects.toThrow(/Blocked/);
    expect(calls).toEqual([]);
  });

  it('goes on the process fetch once, and again if something replaced it', async () => {
    const { calls, original } = passThrough();
    const target = { fetch: original };
    installFetchGuard(target);
    const first = target.fetch;
    installFetchGuard(target);
    expect(target.fetch).toBe(first);
    target.fetch = original;
    installFetchGuard(target);
    await expect(target.fetch('https://cdn.openwa.dev/patches.json')).resolves.toBeInstanceOf(Response);
    expect(calls).toEqual([]);
  });
});

describe('the session browser', () => {
  it('starts on a debugging pipe, without the certificate bypass, with telemetry hosts unresolvable', () => {
    const hardened = hardenLaunch({
      headless: true,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
        '--ignore-certifcate-errors',
        '--remote-debugging-port=9222',
        '--remote-debugging-address=0.0.0.0',
        '--disable-web-security',
        '--host-resolver-rules=MAP * 127.0.0.1',
        '--disable-gpu',
      ],
    });
    expect(hardened.pipe).toBe(true);
    expect(hardened.headless).toBe(true);
    expect(hardened.args).toEqual(['--autoplay-policy=no-user-gesture-required', '--disable-gpu', BLOCKED_HOSTS_RULE]);
    for (const host of ['openwa.dev', '*.openwa.dev', '*.openwa.cloud', 'crashlogs.whatsapp.net', 'dit.whatsapp.net']) {
      expect(BLOCKED_HOSTS_RULE).toContain(`MAP ${host} ~NOTFOUND`);
    }
  });

  it('wraps open-wa’s driver so every launch is hardened', async () => {
    const launched: Record<string, unknown>[] = [];
    class FakePuppeteerDriver {
      puppeteer?: { launch: (options: Record<string, unknown>) => Promise<unknown> };
      async init() {
        this.puppeteer = { launch: async options => void launched.push(options) };
      }
      async launch(options: Record<string, unknown>) {
        return this.puppeteer!.launch({
          ...options,
          args: ['--ignore-certificate-errors', ...(options.args as string[])],
        });
      }
    }
    const Hardened = hardenedDriverClass(FakePuppeteerDriver);
    const driver = new Hardened() as unknown as FakePuppeteerDriver;
    await driver.init();
    await driver.launch({ args: ['--disable-gpu'] });
    expect(launched).toEqual([{ args: ['--disable-gpu', BLOCKED_HOSTS_RULE], pipe: true }]);

    class Unsecurable {
      async init() {}
    }
    await expect(new (hardenedDriverClass(Unsecurable))().init()).rejects.toThrow(/cannot be secured/);
  });
});

describe('clients that skip the global fetch (axios, undici)', () => {
  it('reads the address of a node:http(s) request from a URL, a string or options', () => {
    expect(requestUrlOf(['https://cdn.openwa.dev/patches.json'], 'https:')?.hostname).toBe('cdn.openwa.dev');
    expect(
      requestUrlOf([new URL('https://raw.githubusercontent.com/open-wa/x/patches.json')], 'https:')?.pathname,
    ).toBe('/open-wa/x/patches.json');
    expect(requestUrlOf([{ host: 'funcs.openwa.dev:443', path: '/license' }], 'https:')?.href).toBe(
      'https://funcs.openwa.dev/license',
    );
  });

  it('never resolves open-wa or WhatsApp telemetry hosts, and leaves the rest alone', () => {
    expect(lookupAllowed('cdn.openwa.dev')).toBe(false);
    expect(lookupAllowed('FUNCS.OPENWA.DEV.')).toBe(false);
    expect(lookupAllowed('crashlogs.whatsapp.net')).toBe(false);
    expect(lookupAllowed('web.whatsapp.com')).toBe(true);
    expect(lookupAllowed('notopenwa.dev')).toBe(true);
  });

  it('refuses those addresses through https and name lookups once installed, without touching the network', async () => {
    installNetworkGuard();
    installNetworkGuard();
    expect(() => https.get('https://cdn.openwa.dev/patches.json')).toThrow(/Blocked/);
    expect(() =>
      https.request({ hostname: 'raw.githubusercontent.com', path: '/open-wa/wa-automate/patches.json' }),
    ).toThrow(/Blocked/);
    await expect(dns.promises.lookup('cdn.openwa.dev')).rejects.toThrow(/Blocked/);
    const error = await new Promise<NodeJS.ErrnoException | null>(resolve =>
      dns.lookup('dit.whatsapp.net', failure => resolve(failure)),
    );
    expect(error?.code).toBe('ENOTFOUND');
  });
});
