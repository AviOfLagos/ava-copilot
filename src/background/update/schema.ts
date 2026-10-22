import { z } from 'zod';

/** The plain `x.y.z` shape every version in this project uses (see ./semver.ts). */
const SEMVER_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const semver = () => z.string().regex(SEMVER_PATTERN).max(20);

/**
 * The shape of https://nex-copilot-one.vercel.app/version.json (built by site/src/pages/version.json.ts from the
 * repo's own package.json version and site/src/content/release-notes.ts). Every string is length-capped, so an
 * unexpectedly large or malformed feed is refused by `.safeParse` in ./check.ts rather than stored or shown.
 */
export const versionInfoSchema = z.object({
  version: semver(),
  released: z.string().max(40),
  notes: z.array(z.string().max(240)).max(20),
  extension: z.object({ url: z.string().max(300), command: z.string().max(400) }),
  brain: z.object({ version: semver(), command: z.string().max(400) }),
});

export type VersionInfo = z.infer<typeof versionInfoSchema>;
