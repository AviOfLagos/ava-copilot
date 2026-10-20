import { createHash } from 'node:crypto';

/**
 * Keeps open-wa from running code or reaching hosts nobody reviewed.
 *
 * - **Live patches.** On every launch @open-wa/core fetches https://cdn.openwa.dev/patches.json (fallback
 *   raw.githubusercontent.com/open-wa/…) with Node's global fetch and injects the scripts into the logged-in
 *   WhatsApp Web page; create() cannot turn that off. Whoever controls that host could read every chat and send to
 *   anyone. The guard answers those addresses itself with the vendored set below, pinned by sha256, and refuses
 *   every other request to an open-wa host (licences, sticker and link services). A pinned set that does not match
 *   is never served. The set is empty: the client's own bundled WAPI (wapi.js) carries sendText, getMe and the
 *   message listeners, and open-wa goes on without remote patches when the fetch gives none. If a WhatsApp Web
 *   update ever needs one, it is reviewed, committed here and pinned, never fetched.
 * - **The browser.** open-wa starts Chrome with a random local debugging port that any process on the Mac could
 *   attach to, and with certificate errors ignored. The launch is changed to a debugging pipe (no port), those
 *   flags are dropped, and open-wa's and WhatsApp's telemetry hosts resolve to nothing.
 */

/** The live patches served to open-wa: none. */
export const VENDORED_PATCHES = '[]';
export const VENDORED_PATCHES_SHA256 = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';

// Hosts that belong to open-wa: nothing may be fetched from them
const OPENWA_DOMAINS = ['openwa.dev', 'openwa.cloud'];
// Paths on GitHub's hosts that belong to open-wa
const OPENWA_GITHUB = /^\/(repos\/)?open-wa(\/|$)/i;
const GITHUB_HOSTS = new Set(['raw.githubusercontent.com', 'github.com', 'api.github.com', 'codeload.github.com']);
// WhatsApp's own crash logs and telemetry, from the session browser
const WHATSAPP_TELEMETRY = ['crashlogs.whatsapp.net', 'dit.whatsapp.net'];

const within = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

function urlOf(input: unknown): URL | null {
  try {
    const raw =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input && typeof input === 'object' && 'url' in input
            ? String((input as { url: unknown }).url)
            : '';
    return raw ? new URL(raw) : null;
  } catch {
    return null;
  }
}

export type Verdict = 'patches' | 'blocked' | 'allowed';

/** What the guard does with a request: serve the pinned patches, refuse it, or let it through. */
export function verdictFor(input: unknown): Verdict {
  const url = urlOf(input);
  if (!url) return 'allowed';
  const host = url.hostname.toLowerCase();
  const openWaGithub = GITHUB_HOSTS.has(host) && OPENWA_GITHUB.test(url.pathname);
  const openWaHost = OPENWA_DOMAINS.some(domain => within(host, domain));
  if (!openWaHost && !openWaGithub && !WHATSAPP_TELEMETRY.some(domain => within(host, domain))) return 'allowed';
  if ((openWaHost || openWaGithub) && /\/patches\.json$/i.test(url.pathname)) return 'patches';
  return 'blocked';
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

type Fetch = typeof fetch;
const GUARDED = Symbol.for('nex-brain.openwa-fetch-guard');

/** A fetch that answers open-wa's patch addresses with the pinned set and refuses its other hosts. */
export function guardedFetch(
  original: Fetch,
  vendored: { body: string; sha256: string } = { body: VENDORED_PATCHES, sha256: VENDORED_PATCHES_SHA256 },
): Fetch {
  const guarded = (async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
    const verdict = verdictFor(input);
    if (verdict === 'allowed') return original(input, init);
    if (verdict === 'patches' && sha256(vendored.body) === vendored.sha256) {
      return new Response(vendored.body, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // Fails closed: a network error, so open-wa goes on with nothing from there
    throw new TypeError('Blocked by Nex Brain: open-wa may not reach this address.');
  }) as Fetch;
  Object.defineProperty(guarded, GUARDED, { value: true });
  return guarded;
}

/** Puts the guard on the process's fetch (again, if anything replaced it). */
export function installFetchGuard(target: { fetch: Fetch } = globalThis): void {
  if ((target.fetch as unknown as Record<symbol, unknown>)[GUARDED]) return;
  target.fetch = guardedFetch(target.fetch.bind(target));
}

// Flags open-wa passes that must not reach the session browser
const DROPPED_ARGS = [
  /^--ignore-certifi?cate-errors/,
  /^--ignore-certifcate-errors/,
  /^--remote-debugging-port/,
  /^--remote-debugging-address/,
  /^--disable-web-security/,
  /^--host-resolver-rules/,
];
export const BLOCKED_HOSTS_RULE = `--host-resolver-rules=${[
  ...OPENWA_DOMAINS.flatMap(d => [d, `*.${d}`]),
  ...WHATSAPP_TELEMETRY,
]
  .map(host => `MAP ${host} ~NOTFOUND`)
  .join(', ')}`;

export interface LaunchOptions {
  args?: string[];
  pipe?: boolean;
  [key: string]: unknown;
}

/** open-wa's puppeteer launch, made safe: a debugging pipe instead of a port, no certificate bypass, no telemetry. */
export function hardenLaunch<T extends LaunchOptions>(options: T): T & { pipe: true; args: string[] } {
  const args = (options.args ?? []).filter(arg => !DROPPED_ARGS.some(pattern => pattern.test(arg)));
  return { ...options, pipe: true, args: [...args, BLOCKED_HOSTS_RULE] };
}
