/**
 * Compares the plain `x.y.z` versions this project uses (package.json, manifest.json, the update feed);
 * nothing here needs pre-release or build-metadata handling because `update_version.sh` only ever writes that
 * shape, and the feed is validated against the same pattern (see ./schema.ts) before this runs.
 */

export function parseVersion(input: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(input.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether `remote` is a newer version than `local`. An unparseable version on either side is never "newer". */
export function isNewerVersion(remote: string, local: string): boolean {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}
