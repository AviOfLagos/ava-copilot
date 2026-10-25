import type { APIRoute } from 'astro';
import { version as brainVersion } from '../../../companion/package.json';
import { RELEASE } from '../content/release-notes';
import { INSTALL_COMMAND, links, SITE_URL, VERSION } from '../content/site';

/**
 * The extension's own update check (src/background/update/check.ts) reads this: a few hundred bytes of JSON,
 * published with the site like any other page, so a normal version bump + `git push` is the whole release step
 * — see docs/task.md. The shape is the contract; src/background/update/schema.ts validates against it exactly.
 */
export const GET: APIRoute = () => {
  const body = {
    version: VERSION,
    released: RELEASE.released,
    notes: RELEASE.notes,
    extension: { url: `${SITE_URL}${links.installScript}`, command: INSTALL_COMMAND },
    brain: {
      version: brainVersion,
      // Ava Brain lives in this repo, not a separate release: pulling it and re-running the installer is the
      // update (see companion/README.md's Install section, which this mirrors).
      command: 'cd companion && git pull && snare shield check . && pnpm install && sh scripts/install-launchagent.sh',
    },
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
};
