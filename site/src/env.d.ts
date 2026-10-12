/// <reference types="astro/client" />

// The extension's `t()`, served at build time by scripts/app-i18n.mjs from public/_locales/en/messages.json
declare module '@extension/i18n' {
  export function t(key: string, substitutions?: string | string[]): string;
}
