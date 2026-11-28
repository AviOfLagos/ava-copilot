import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repo = resolve(import.meta.dirname, '..');

// The window (renderer). The main process and preload are bundled by scripts/build-main.mjs.
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@protocol': resolve(repo, 'src/shared/lib/protocol/companion.ts'),
      '@appearance': resolve(repo, 'src/storage/lib/settings/appearance.ts'),
      // The shared files sit outside this package: they use this package's copies
      zod: resolve(import.meta.dirname, 'node_modules/zod'),
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome140',
  },
});
