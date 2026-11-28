import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const repo = resolve(import.meta.dirname, '..');

export default defineConfig({
  resolve: {
    alias: {
      '@protocol': resolve(repo, 'src/shared/lib/protocol/companion.ts'),
      '@appearance': resolve(repo, 'src/storage/lib/settings/appearance.ts'),
      zod: resolve(import.meta.dirname, 'node_modules/zod'),
    },
  },
  test: { include: ['src/**/*.test.ts'] },
});
