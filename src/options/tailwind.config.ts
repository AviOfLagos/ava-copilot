import { resolve } from 'node:path';
// Tailwind's config loader ignores WXT aliases, so import withUI from source.
import { withUI } from '../ui/lib/withUI';
// The Models tab renders the panel's Models page: its colours and its files come along
import panel from '../side-panel/tailwind.config';

/*
 * The settings page renders its dark variant always (Options.tsx), and the colours that variant uses
 * are mapped here to the panel's theme variables (src/ui/lib/theme.css). The components keep their
 * upstream classes, and the page follows Graphite glass, in Dark, Light or System like the panel.
 */
const surface = {
  500: 'var(--color-muted-foreground)',
  600: 'var(--color-input)',
  700: 'var(--color-accent)',
  800: 'var(--glass-top)',
  900: 'var(--color-background)',
};

export default withUI({
  // This config sits in the page folder; don't scan it for class names.
  content: [
    resolve(__dirname, '**/*.{js,ts,jsx,tsx}'),
    `!${resolve(__dirname, 'tailwind.config.ts')}`,
    resolve(__dirname, '../side-panel/models/**/*.{ts,tsx}'),
    resolve(__dirname, '../side-panel/components/ui/**/*.{ts,tsx}'),
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Geist Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono Variable"', 'ui-monospace', 'monospace'],
      },
      colors: {
        ...(panel.theme?.extend?.colors as Record<string, unknown>),
        slate: surface,
        gray: {
          100: 'var(--color-accent)',
          200: 'var(--color-foreground)',
          300: 'var(--color-foreground)',
          400: 'var(--color-muted-foreground)',
          500: 'var(--color-muted-foreground)',
          600: 'var(--color-input)',
          700: 'var(--color-border)',
        },
        // The page's accent was blue; it is the panel's mint, deep enough for white text on fills
        blue: {
          100: 'var(--color-foreground)',
          200: 'rgb(var(--primary-rgb))',
          300: 'rgb(var(--primary-rgb))',
          400: 'rgb(var(--primary-rgb))',
          500: 'var(--primary-strong)',
          600: 'var(--primary-strong)',
          700: 'var(--primary-strong)',
          800: 'var(--color-ring)',
          900: 'var(--primary-tint)',
        },
        background: 'var(--color-background)',
        foreground: 'var(--color-foreground)',
        border: 'var(--color-border)',
      },
    },
  },
  plugins: [],
});
