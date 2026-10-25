import { AppError, toAppError } from '@extension/shared';
import { versionInfoSchema } from './schema';
import type { VersionInfo } from './schema';

/**
 * Ava Copilot's own site, published alongside it (site/src/pages/version.json.ts, built from the repo's own
 * version and site/src/content/release-notes.ts). Not a third-party call: it is the product checking its own
 * download page, no account and no identifiers involved — see the "Check for updates" setting
 * (src/side-panel/update/UpdateSettings.tsx) for where that is explained to the user.
 */
// The old address (nex-copilot-one.vercel.app) serves the same site, so copies that still check it hear about
// this version too
export const UPDATE_FEED_URL = 'https://ava.nexprove.com/version.json';
const TIMEOUT_MS = 8_000;
// The feed is a few hundred bytes of JSON; anything past this is refused rather than parsed
const MAX_BYTES = 20_000;

export interface FetchVersionInfoOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  url?: string;
}

/**
 * Reads and validates the update feed: no cookies, no headers that could identify this browser, a timeout, a
 * size cap, and the reply must match the schema exactly before anything here trusts it.
 *
 * @throws AppError with a sentence fit to show the user
 */
export async function fetchVersionInfo(options: FetchVersionInfoOptions = {}): Promise<VersionInfo> {
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const signals = [AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);

  let response: Response;
  try {
    response = await fetchFn(options.url ?? UPDATE_FEED_URL, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    if (options.signal?.aborted) throw new AppError('cancelled', 'Stopped.');
    throw new AppError('network', 'Could not reach the update feed. Check your connection and try again.', {
      cause: error,
    });
  }
  if (!response.ok) {
    throw toAppError({ status: response.status, message: `The update check answered ${response.status}.` });
  }

  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BYTES) {
    throw new AppError('invalid', 'The update feed is unexpectedly large; not checked.');
  }
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new AppError('invalid', 'The update feed is unexpectedly large; not checked.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AppError('invalid', 'The update feed is not valid JSON.', { cause: error });
  }
  const checked = versionInfoSchema.safeParse(parsed);
  if (!checked.success) {
    throw new AppError('invalid', 'The update feed did not match the expected shape.', { cause: checked.error });
  }
  return checked.data;
}
