import { resolve } from 'node:path';
import type { Config } from 'tailwindcss/types/config';
import panel from '../side-panel/tailwind.config';

// The panel's theme, scanning this page's own files
export default {
  ...panel,
  content: [resolve(__dirname, '**/*.{js,ts,jsx,tsx}'), `!${resolve(__dirname, 'tailwind.config.ts')}`],
} as Config;
