import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { COMPANION_EXTENSION_ORIGIN, healthReplySchema, pairReplySchema } from '@protocol';
import { bearerToken, CODE_TTL_MS, MAX_CODE_ATTEMPTS, newPairingCode, PairingStore } from '../auth/pairing';
import { startTestBrain, tempDir } from './helpers';

describe('PairingStore', () => {
  const dirs: { remove: () => void }[] = [];
  afterEach(() => dirs.splice(0).forEach(dir => dir.remove()));
  const store = (now = () => 1_000) => {
    const dir = tempDir();
    dirs.push(dir);
    return new PairingStore(dir.path, now);
  };

  it('makes codes from the alphabet without look-alikes', () => {
    for (let i = 0; i < 50; i++) expect(newPairingCode()).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  });

  it('trades a code once for a token it then recognises', async () => {
    const pairing = store();
    const code = await pairing.createCode();
    const { token } = await pairing.redeem(code.toLowerCase().replace('-', ' '), 'Brave');
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(await pairing.verify(token)).toBe(true);
    expect(await pairing.verify(`${token}x`)).toBe(false);
    await expect(pairing.redeem(code, 'Brave')).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('burns a code after too many wrong tries', async () => {
    const pairing = store();
    const code = await pairing.createCode();
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      await expect(pairing.redeem('AAAA-AAAA', 'x')).rejects.toMatchObject({ kind: 'forbidden' });
    }
    await expect(pairing.redeem(code, 'x')).rejects.toThrow(/No pairing code is waiting/);
  });

  it('refuses an expired code', async () => {
    let now = 1_000;
    const pairing = store(() => now);
    const code = await pairing.createCode();
    now += CODE_TTL_MS + 1;
    await expect(pairing.redeem(code, 'x')).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('fails closed: no token, an empty or revoked token is never accepted', async () => {
    const pairing = store();
    expect(await pairing.verify(null)).toBe(false);
    expect(await pairing.verify('')).toBe(false);
    const { token } = await pairing.redeem(await pairing.createCode(), 'x');
    await pairing.revoke();
    expect(await pairing.verify(token)).toBe(false);
    expect((await pairing.status()).paired).toBe(false);
  });

  it('only one of two tries at once can spend a code', async () => {
    const pairing = store();
    const code = await pairing.createCode();
    const results = await Promise.allSettled([pairing.redeem(code, 'a'), pairing.redeem(code, 'b')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('reads bearer tokens strictly', () => {
    expect(bearerToken('Bearer abcdefghijklmnopqrstuvwxyz')).toBe('abcdefghijklmnopqrstuvwxyz');
    expect(bearerToken('Basic abcdefghijklmnopqrstuvwxyz')).toBeNull();
    expect(bearerToken('Bearer short')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('the server is closed by default', () => {
  let test: Awaited<ReturnType<typeof startTestBrain>>;
  afterEach(async () => test?.stop());

  it('pairs, then answers health only with the token and the extension origin', async () => {
    test = await startTestBrain();
    expect((await test.api('/v1/health', { token: null })).status).toBe(401);
    const paired = pairReplySchema.parse(await test.pair());
    expect(paired.protocol).toBe(1);

    const ok = await test.api('/v1/health');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(COMPANION_EXTENSION_ORIGIN);
    const health = healthReplySchema.parse(await ok.json());
    expect(health.docker.state).toBe('up');

    expect((await test.api('/v1/health', { token: 'x'.repeat(43) })).status).toBe(401);
    expect((await test.api('/v1/health', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await test.api('/v1/health', { origin: null })).status).toBe(403);
    expect(
      (await test.api('/v1/health', { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' })).status,
    ).toBe(403);
  });

  it('refuses pairing from any other origin and a wrong code', async () => {
    test = await startTestBrain();
    const code = await test.brain.pairing.createCode();
    const elsewhere = await test.api('/v1/pair', {
      method: 'POST',
      origin: 'https://evil.example',
      token: null,
      body: JSON.stringify({ code, client: 'x' }),
    });
    expect(elsewhere.status).toBe(403);
    const wrong = await test.api('/v1/pair', {
      method: 'POST',
      token: null,
      body: JSON.stringify({ code: 'ABCD-EFGH', client: 'x' }),
    });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('refuses a request that names another host (DNS rebinding)', async () => {
    test = await startTestBrain();
    await test.pair();
    const port = new URL(test.base).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/health',
          headers: { Host: `evil.example:${port}`, Origin: COMPANION_EXTENSION_ORIGIN },
        },
        res => resolve(res.statusCode ?? 0),
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('answers the preflight only for the extension', async () => {
    test = await startTestBrain();
    const ok = await test.api('/v1/health', { method: 'OPTIONS', token: null });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(
      (await test.api('/v1/health', { method: 'OPTIONS', token: null, origin: 'https://evil.example' })).status,
    ).toBe(403);
  });

  it('keeps the internal API for the eve process only', async () => {
    test = await startTestBrain();
    const secret = test.brain.internalSecret;
    const path = '/internal/profiles/someone';
    expect((await test.api(path, { origin: null, token: null })).status).toBe(401);
    expect((await test.api(path, { origin: null, token: 'y'.repeat(43) })).status).toBe(401);
    // A web page always sends an Origin; even with the secret it is refused
    expect((await test.api(path, { token: secret })).status).toBe(403);
    expect((await test.api(path, { origin: null, token: secret })).status).toBe(404);
  });

  it('never writes the token or the code into its logs', async () => {
    test = await startTestBrain();
    const { token } = await test.pair();
    await test.api('/v1/health');
    await test.api('/v1/health', { token: 'z'.repeat(43) });
    const text = test.log.lines.join('\n');
    expect(text).toContain('"route":"health"');
    expect(text).not.toContain(token);
  });

  it('limits pairing attempts per minute', async () => {
    test = await startTestBrain();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const response = await test.api('/v1/pair', {
        method: 'POST',
        token: null,
        body: JSON.stringify({ code: 'ABCD-EFGH', client: 'x' }),
      });
      statuses.push(response.status);
      if (response.status === 429) expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    }
    expect(statuses.slice(0, 5).every(status => status === 403)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});
