// Bundles Nex Brain into one file, dist/nex-brain.mjs. Its own sources, the shared protocol and the
// extension's workflow engine (engine, spec, templates, errors, retry) are compiled in; npm packages stay
// external and load from companion/node_modules.
import { chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(here, '..');
const outfile = resolve(here, 'dist/nex-brain.mjs');

await build({
  absWorkingDir: here,
  entryPoints: [resolve(here, 'src/main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  tsconfig: resolve(here, 'tsconfig.json'),
  // Applied before any tsconfig paths, so the extension's own aliases (which reach React code) never apply
  alias: {
    '@protocol': resolve(repo, 'src/shared/lib/protocol/companion.ts'),
    '@engine': resolve(repo, 'src/background/workflows'),
    '@extension/shared': resolve(here, 'src/engine/shared.ts'),
    '@extension/storage': resolve(here, 'src/engine/storage-types.ts'),
  },
  external: ['zod', 'croner', 'ai', '@ai-sdk/*', '@modelcontextprotocol/*', 'eve', 'eve/*', '@open-wa/*'],
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  logLevel: 'warning',
});
chmodSync(outfile, 0o755);
console.log(`Built ${outfile}`);
