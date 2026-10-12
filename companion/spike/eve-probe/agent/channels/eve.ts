import { createHash, timingSafeEqual } from 'node:crypto';
import { ForbiddenError } from 'eve/channels/auth';
import type { AuthFn } from 'eve/channels/auth';
import { eveChannel } from 'eve/channels/eve';

// (f) Fail-closed route auth: a bearer token compared in constant time, and the extension's origin
const EXTENSION_ORIGIN = 'chrome-extension://fckijnclcihjnokahdnbogpbeiimfdio';

function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const aviPairing: AuthFn<Request> = async request => {
  const expected = process.env.PROBE_TOKEN;
  // No token configured: nobody gets in
  if (!expected) throw new ForbiddenError({ code: 'not_paired', message: 'Not paired.' });
  const header = request.headers.get('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!given || !sameSecret(given, expected)) return null;
  if (request.headers.get('origin') !== EXTENSION_ORIGIN) {
    throw new ForbiddenError({ code: 'origin', message: 'Wrong origin.' });
  }
  return {
    authenticator: 'avi-pairing',
    principalId: 'avi',
    principalType: 'user',
    attributes: { profileId: request.headers.get('x-avi-profile') ?? 'writer' },
  };
};

export default eveChannel({ auth: [aviPairing] });
