// A Vite plugin that stands in for the extension's `@extension/i18n`.
//
// In the extension, `t()` reads public/_locales through chrome.i18n, which a web page does not have. Here the same
// `t()` reads the English messages at build time, so the app's widgets (the composer, the dictation strip) show
// exactly the words they show in the panel. Only the keys named in the files below are bundled, not all 1,400.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ID = '@extension/i18n';
const RESOLVED = '\0avi-app-i18n';

// The app files the site imports, plus the site's own source (its content model reads some app strings)
const APP_FILES = [
  'src/side-panel/components/Composer.tsx',
  'src/side-panel/components/Dictation.tsx',
  'src/side-panel/components/ai/chain-of-thought.tsx',
  'src/side-panel/components/ui/hold-button.tsx',
];

function listFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) listFiles(path, out);
    else if (/\.(ts|tsx|astro|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

export function appI18n({ repoRoot, siteRoot }) {
  return {
    name: 'avi-app-i18n',
    enforce: 'pre',
    resolveId(id) {
      return id === ID ? RESOLVED : undefined;
    },
    load(id, options) {
      if (id !== RESOLVED) return undefined;
      const messagesPath = join(repoRoot, 'public/_locales/en/messages.json');
      const messages = JSON.parse(readFileSync(messagesPath, 'utf8'));
      // The pages are rendered at build time and pass their words to the islands as props, so the browser's copy
      // needs only the keys the app's widgets and the islands look up themselves
      const appFiles = APP_FILES.map(file => join(repoRoot, file));
      const siteFiles = listFiles(join(siteRoot, options?.ssr ? 'src' : 'src/islands'));
      const files = [...appFiles, ...siteFiles];
      const used = {};
      for (const file of files) {
        this.addWatchFile(file);
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(/['"`]([a-z][A-Za-z0-9_]*)['"`]/g)) {
          const entry = messages[match[1]];
          if (entry) used[match[1]] = { message: entry.message, placeholders: entry.placeholders };
        }
      }
      this.addWatchFile(messagesPath);
      return `const MESSAGES = ${JSON.stringify(used)};
/** chrome.i18n.getMessage, for the keys the site uses: named placeholders, then $1..$9. Unknown keys give ''. */
export function t(key, substitutions) {
  const entry = MESSAGES[key];
  if (!entry) return '';
  const list = substitutions == null ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];
  let text = entry.message;
  for (const [name, placeholder] of Object.entries(entry.placeholders || {})) {
    text = text.split(new RegExp('\\\\$' + name + '\\\\$', 'i')).join(placeholder.content);
  }
  return text.replace(/\\$(\\d)/g, (_, n) => list[Number(n) - 1] ?? '').replace(/\\$\\$/g, '$');
}
`;
    },
  };
}
