import { fileURLToPath } from 'node:url';
import animate from 'tailwindcss-animate';

// Tailwind only styles the app's own widgets that the site imports from ../src, plus the demo's markup, so they look
// exactly as they do in the side panel. The theme below mirrors src/side-panel/tailwind.config.ts (it can't be
// imported: that file resolves its plugin from the extension's node_modules). Colours read theme.css variables.
const app = fileURLToPath(new URL('../src/side-panel/components/', import.meta.url));
const withAlpha = name => `rgb(var(--${name}-rgb) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './src/**/*.{astro,ts,tsx}',
    `${app}ui/{button,badge,hold-button,thinking-orb,live-orb}.tsx`,
    `${app}ai/chain-of-thought.tsx`,
    `${app}{Composer,Dictation}.tsx`,
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Geist Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono Variable"', 'ui-monospace', 'monospace'],
      },
      colors: {
        background: 'var(--color-background)',
        foreground: 'var(--color-foreground)',
        muted: { DEFAULT: 'var(--color-muted)', foreground: 'var(--color-muted-foreground)' },
        card: { DEFAULT: 'var(--color-card)', foreground: 'var(--color-foreground)' },
        popover: { DEFAULT: 'var(--color-popover)', foreground: 'var(--color-popover-foreground)' },
        secondary: { DEFAULT: 'var(--color-secondary)', foreground: 'var(--color-secondary-foreground)' },
        accent: { DEFAULT: 'var(--color-accent)', foreground: 'var(--color-accent-foreground)' },
        border: 'var(--color-border)',
        input: 'var(--color-input)',
        ring: 'var(--color-ring)',
        primary: { DEFAULT: withAlpha('primary'), foreground: 'var(--color-primary-foreground)' },
        hold: { DEFAULT: withAlpha('hold'), foreground: 'var(--color-hold-foreground)' },
        call: { DEFAULT: withAlpha('call') },
        destructive: { DEFAULT: withAlpha('destructive') },
      },
      borderColor: { DEFAULT: 'var(--color-border)' },
    },
  },
  plugins: [animate],
};
