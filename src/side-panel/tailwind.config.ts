import { resolve } from 'node:path';
import type { Config } from 'tailwindcss/types/config';
import animate from 'tailwindcss-animate';
import { densitySpacing } from '../ui/lib/density';

// Colours read the theme variables in index.css; the ones with an alpha channel take opacity modifiers
const withAlpha = (name: string) => `rgb(var(--${name}-rgb) / <alpha-value>)`;

export default {
  // This config sits in the page folder; don't scan it for class names.
  content: [resolve(__dirname, '**/*.{js,ts,jsx,tsx}'), `!${resolve(__dirname, 'tailwind.config.ts')}`],
  theme: {
    extend: {
      // The spacing scale follows the person's density setting (--density, set by layout/theme.ts)
      spacing: densitySpacing,
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
      keyframes: {
        progress: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        progress: 'progress 1.5s infinite ease-in-out',
      },
    },
  },
  plugins: [animate],
} as Config;
