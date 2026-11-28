// Bundles the main process and the preload into dist/ (CommonJS, as Electron loads them). The window is built by
// Vite (vite.config.ts) into dist/renderer.
import { resolve } from 'node:path';
import { build } from 'esbuild';

const here = resolve(import.meta.dirname, '..');
const repo = resolve(here, '..');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  alias: {
    '@protocol': resolve(repo, 'src/shared/lib/protocol/companion.ts'),
    '@appearance': resolve(repo, 'src/storage/lib/settings/appearance.ts'),
  },
  nodePaths: [resolve(here, 'node_modules')],
  logLevel: 'warning',
};

await build({ ...common, entryPoints: [resolve(here, 'src/main/main.ts')], outfile: resolve(here, 'dist/main.cjs') });
await build({
  ...common,
  entryPoints: [resolve(here, 'src/main/preload.ts')],
  outfile: resolve(here, 'dist/preload.cjs'),
});
