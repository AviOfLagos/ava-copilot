import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const repo = resolve(import.meta.dirname, '..');

// The same aliases as tsconfig.json and scripts/build.mjs: the protocol and the workflow engine come from
// the extension's source, so both sides always run the same code.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@protocol$/, replacement: resolve(repo, 'src/shared/lib/protocol/companion.ts') },
      { find: /^@engine\/(.*)$/, replacement: resolve(repo, 'src/background/workflows/$1') },
      { find: /^@extension\/shared$/, replacement: resolve(import.meta.dirname, 'src/engine/shared.ts') },
      { find: /^@extension\/storage$/, replacement: resolve(import.meta.dirname, 'src/engine/storage-types.ts') },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
