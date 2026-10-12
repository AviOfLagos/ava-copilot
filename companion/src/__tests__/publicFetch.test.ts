import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { publicOnlyFetch, publicOnlyLookup } from '../workflows/publicFetch';
import type { Resolver } from '../workflows/publicFetch';

function lookupWith(resolve: Resolver, options: { all?: boolean; family?: number } = {}) {
  return new Promise<{ error: Error | null; address: unknown; family?: number }>(done =>
    publicOnlyLookup(resolve)('news.example', options, (error, address, family) => done({ error, address, family })),
  );
}

const servers: { close: () => void }[] = [];
afterEach(() => servers.splice(0).forEach(server => server.close()));

async function localServer() {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits++;
    response.end('{"secret": true}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, hits: () => hits };
}

describe('publicOnlyLookup', () => {
  it('gives the socket a public address, one or all of them', async () => {
    const resolve: Resolver = async () => [{ address: '93.184.216.34' }, { address: '2606:2800:220:1::1' }];
    expect(await lookupWith(resolve)).toEqual({ error: null, address: '93.184.216.34', family: 4 });
    expect((await lookupWith(resolve, { all: true })).address).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 },
    ]);
    expect((await lookupWith(resolve, { family: 6 })).address).toBe('2606:2800:220:1::1');
  });

  it('refuses a name with any private or local address among its answers', async () => {
    for (const address of ['127.0.0.1', '10.0.0.8', '192.168.1.10', '::1', '::ffff:127.0.0.1', 'fd00::1']) {
      const result = await lookupWith(async () => [{ address: '93.184.216.34' }, { address }]);
      expect(result.error).toMatchObject({ kind: 'forbidden' });
    }
    expect((await lookupWith(async () => [])).error).toMatchObject({ kind: 'network' });
  });
});

describe('publicOnlyFetch', () => {
  it('never connects when the name leads to the Mac itself, even after a public first answer', async () => {
    const local = await localServer();
    let answers = 0;
    // DNS rebinding: public for the check, the Mac's own address for the connection
    const resolve: Resolver = async () => [{ address: answers++ === 0 ? '93.184.216.34' : '127.0.0.1' }];
    expect(await lookupWith(resolve)).toMatchObject({ error: null });
    await expect(publicOnlyFetch(resolve)(`http://news.example:${local.port}/`)).rejects.toMatchObject({
      kind: 'forbidden',
    });
    await expect(publicOnlyFetch(async () => [])(`http://127.0.0.1:${local.port}/`)).rejects.toMatchObject({
      kind: 'forbidden',
    });
    expect(local.hits()).toBe(0);
  });

  it('only reads', async () => {
    await expect(
      publicOnlyFetch(async () => [{ address: '93.184.216.34' }])('https://news.example/', { method: 'POST' }),
    ).rejects.toMatchObject({ kind: 'invalid' });
  });
});
