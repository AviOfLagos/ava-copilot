import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupAddress, LookupOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { AppError } from '@extension/shared';
import { isPrivateHost } from '@engine/net';

/**
 * A GET for routines on the Mac that can only reach public addresses. The address is checked inside the socket's own
 * name lookup, so what is checked is what is connected to: a name that answers with a public address first and a
 * private one a moment later (DNS rebinding) cannot reach the Mac's own services. Redirects are never followed.
 */

export type Resolver = (host: string) => Promise<{ address: string; family?: number }[]>;

export const systemResolver: Resolver = host => dnsLookup(host, { all: true, verbatim: true });

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function familyOf(address: string, family?: number): number {
  return family ?? (address.includes(':') ? 6 : 4);
}

/** A `lookup` for sockets that refuses a name with any private or local address. */
export function publicOnlyLookup(resolve: Resolver): LookupFunction {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    const family = options?.family === 'IPv4' ? 4 : options?.family === 'IPv6' ? 6 : options?.family;
    resolve(hostname).then(
      addresses => {
        if (!addresses.length) return callback(new AppError('network', `${hostname} could not be found.`), '');
        if (addresses.some(entry => isPrivateHost(entry.address))) {
          return callback(
            new AppError('forbidden', `${hostname} leads to a private or local address.`, { retryable: false }),
            '',
          );
        }
        const wanted = addresses.filter(entry => !family || familyOf(entry.address, entry.family) === family);
        const usable = wanted.length ? wanted : addresses;
        if (options?.all) {
          return callback(
            null,
            usable.map(entry => ({ address: entry.address, family: familyOf(entry.address, entry.family) })),
          );
        }
        return callback(null, usable[0].address, familyOf(usable[0].address, usable[0].family));
      },
      error => callback(new AppError('network', `${hostname} could not be found.`, { cause: error }), ''),
    );
  };
}

/** A `fetch` (GET only) whose connections go through `publicOnlyLookup`. */
export function publicOnlyFetch(resolve: Resolver = systemResolver): typeof fetch {
  const lookup = publicOnlyLookup(resolve);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const send = url.protocol === 'https:' ? httpsRequest : url.protocol === 'http:' ? httpRequest : null;
    if (!send) throw new AppError('forbidden', `${url.protocol} addresses are not fetched.`, { retryable: false });
    // An address written as numbers never goes through a name lookup, so it is checked here
    if (isPrivateHost(url.hostname)) {
      throw new AppError('forbidden', `${url.hostname} is a private or local address.`, { retryable: false });
    }
    if (init?.method && init.method.toUpperCase() !== 'GET') {
      throw new AppError('invalid', 'Routines only read with GET here.', { retryable: false });
    }
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    return await new Promise<Response>((resolvePromise, reject) => {
      const request = send(url, { method: 'GET', headers, lookup, signal: init?.signal ?? undefined }, response => {
        const replyHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach(item => replyHeaders.append(name, item));
          else if (value !== undefined) replyHeaders.set(name, value);
        }
        const status = response.statusCode ?? 502;
        const empty = [101, 204, 205, 304].includes(status);
        if (empty) response.resume();
        resolvePromise(
          new Response(empty ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), {
            status,
            statusText: response.statusMessage,
            headers: replyHeaders,
          }),
        );
      });
      request.on('error', reject);
      request.end();
    });
  }) as typeof fetch;
}
