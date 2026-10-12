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

/** The eight 16-bit groups of an IPv6 address, or null if it is not one. Handles :: and a dotted IPv4 tail. */
function ipv6Groups(address: string): number[] | null {
  let text = address;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const parts = tail[1].split('.').map(Number);
    if (parts.some(part => part > 255)) return null;
    text = `${text.slice(0, -tail[1].length)}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(':').map(group => parseInt(group, 16)) : []);
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [...head, ...new Array(halves.length === 2 ? missing : 0).fill(0), ...rest];
  return groups.length === 8 && groups.every(group => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : null;
}

function ipv6Private(groups: number[]): boolean {
  const [a] = groups;
  const embedded = (high: number, low: number) =>
    ipv4Private(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`) === true;
  // Unspecified and loopback
  if (groups.slice(0, 7).every(group => group === 0) && groups[7] <= 1) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d)
  if (groups.slice(0, 5).every(group => group === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    return embedded(groups[6], groups[7]);
  }
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an IPv4 address too
  if (a === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every(group => group === 0)) {
    return embedded(groups[6], groups[7]);
  }
  if (a === 0x2002) return embedded(groups[1], groups[2]);
  // Unique local fc00::/7, link-local fe80::/10, old site-local fec0::/10, multicast ff00::/8
  return (a & 0xfe00) === 0xfc00 || (a & 0xffc0) === 0xfe80 || (a & 0xffc0) === 0xfec0 || (a & 0xff00) === 0xff00;
}

/** The host as the browser will use it: numbers in any form become dotted IPv4, IPv6 is normalised. */
function canonicalHost(rawHost: string): string {
  const host = rawHost.trim().toLowerCase().replace(/\.$/, '');
  try {
    const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return new URL(`http://${bracketed}/`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return host.replace(/^\[|\]$/g, '');
  }
}

/** Whether a host name or address is private, local or otherwise not a public site. */
export function isPrivateHost(rawHost: string): boolean {
  const host = canonicalHost(rawHost);
  if (!host || host === 'localhost') return true;
  const v4 = ipv4Private(host);
  if (v4 !== null) return v4;
  if (host.includes(':')) {
    const groups = ipv6Groups(host);
    // An address that cannot be read is treated as private
    return groups ? ipv6Private(groups) : true;
  }
  // A single label ("router", "nas") only resolves on a local network
  if (!host.includes('.')) return true;
  return PRIVATE_SUFFIXES.some(suffix => host === suffix.slice(1) || host.endsWith(suffix));
}
