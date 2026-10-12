import { fileURLToPath } from 'node:url';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';
import tailwindcss from 'tailwindcss';
import { appI18n } from './scripts/app-i18n.mjs';

// No usage data leaves a build: Astro's CLI telemetry is on by default (the scripts in package.json set it too)
process.env.ASTRO_TELEMETRY_DISABLED = '1';

// One variable sets canonicals, the sitemap, OG image URLs and the host in the install command.
const SITE_URL = (process.env.SITE_URL || 'https://avi-copilot.vercel.app').replace(/\/+$/, '');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const siteRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  site: SITE_URL,
  trailingSlash: 'never',
  build: { format: 'file' },
  devToolbar: { enabled: false },
  integrations: [
    react(),
    // The OG card templates are screenshotted at build and then removed; they are never pages
    sitemap({ filter: page => !page.includes('/og-card/'), lastmod: new Date() }),
  ],
  vite: {
    // One tsconfig for every file, the app's included: the extension's own tsconfig extends a generated file
    // (.wxt/) that a clean checkout does not have
    tsconfig: `${siteRoot}tsconfig.json`,
    plugins: [appI18n({ repoRoot, siteRoot })],
    resolve: {
      alias: [
        // The extension's source, read-only: its widgets and CSS are imported as they are
        { find: /^@app\//, replacement: `${repoRoot}src/` },
        // The app's widgets import `cn` from @extension/ui: the same helper, minus tailwind-merge (see src/lib/cn.ts)
        { find: /^@extension\/ui$/, replacement: `${siteRoot}src/lib/cn.ts` },
      ],
      // Files under ../src import these by bare name; resolve them from the site's own node_modules, so the site
      // builds from a clean checkout without the extension's dependencies installed
      dedupe: [
        'react',
        'react-dom',
        'clsx',
        'lucide-react',
        '@radix-ui/react-collapsible',
        '@radix-ui/react-use-controllable-state',
      ],
    },
    css: {
      transformer: 'postcss',
      postcss: { plugins: [tailwindcss({ config: `${siteRoot}tailwind.config.mjs` })] },
    },
    server: { fs: { allow: [repoRoot] } },
  },
});
