/**
 * Where a routine may never reach on its own: this machine, the home or office network, and cloud
 * metadata addresses. A routine's list of sites is approved by the user, but a list could still name
 * a router, the Mac companion or a private service, and those must stay out of reach whatever it says.
 * Names that resolve to a private address cannot be told apart from a browser (no DNS lookup here), so
 * only literal addresses and private-looking names are refused; the user's approval covers the rest.
 */

const PRIVATE_SUFFIXES = ['.local', '.localhost', '.internal', '.intranet', '.lan', '.home', '.corp', '.home.arpa'];

function ipv4Private(host: string): boolean | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Whether a host name or address is private, local or otherwise not a public site. */
export function isPrivateHost(rawHost: string): boolean {
  const host = rawHost
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!host || host === 'localhost') return true;
  const v4 = ipv4Private(host);
  if (v4 !== null) return v4;
  if (host.includes(':')) {
    // IPv6: loopback, unspecified, unique-local, link-local, and IPv4-mapped forms of private addresses
    if (host === '::1' || host === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    return mapped ? ipv4Private(mapped[1]) !== false : false;
  }
  // A single label ("router", "nas") only resolves on a local network
  if (!host.includes('.')) return true;
  return PRIVATE_SUFFIXES.some(suffix => host.endsWith(suffix));
}
