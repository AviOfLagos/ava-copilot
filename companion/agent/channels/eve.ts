import { createHash, timingSafeEqual } from 'node:crypto';
import { ForbiddenError } from 'eve/channels/auth';
import type { AuthFn } from 'eve/channels/auth';
import { eveChannel } from 'eve/channels/eve';

/**
 * Only Avi Brain talks to this eve process: it holds the per-boot secret, and it never sends an Origin
 * (a browser always would). The extension speaks to Avi Brain, which checks its pairing token and origin.
 */

const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const aviBrainOnly: AuthFn<Request> = async request => {
  const expected = process.env.AVI_BRAIN_EVE_SECRET;
  // Started without a secret: nobody gets in
  if (!expected) throw new ForbiddenError({ code: 'not_configured', message: 'Not started by Avi Brain.' });
  if (request.headers.get('origin') !== null) throw new ForbiddenError({ code: 'origin', message: 'Not allowed.' });
  const header = request.headers.get('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!given || !sameSecret(given, expected)) return null;
  const profileId = request.headers.get('x-avi-profile');
  const attributes: Record<string, string> = {};
  if (profileId && PROFILE_ID.test(profileId)) attributes.profileId = profileId;
  return { authenticator: 'avi-brain', principalId: 'avi', principalType: 'user', attributes };
};

export default eveChannel({ auth: [aviBrainOnly] });
