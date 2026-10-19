/** Whether an address is a call itself, not a lobby or a home page. */
export function isCallUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname === 'meet.google.com') return /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(pathname);
    if (hostname === 'zoom.us' || hostname.endsWith('.zoom.us')) return /^\/wc\/(join\/)?\d+/.test(pathname);
    if (hostname === 'teams.microsoft.com' || hostname === 'teams.live.com') {
      return /meetup-join|light-meetings|\/meet\//.test(pathname + url);
    }
  } catch {
    // Not an address
  }
  return false;
}
