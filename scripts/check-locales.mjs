#!/usr/bin/env node
// Every locale must have exactly the same message keys (the i18n types are their intersection, so a key
// missing in one locale breaks the build). Run: node scripts/check-locales.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../public/_locales');
const locales = fs.readdirSync(root).filter(name => fs.existsSync(path.join(root, name, 'messages.json')));
const keys = new Map(
  locales.map(locale => [
    locale,
    new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(root, locale, 'messages.json'), 'utf8')))),
  ]),
);
const all = new Set([...keys.values()].flatMap(set => [...set]));
let missing = 0;
for (const [locale, set] of keys) {
  const absent = [...all].filter(key => !set.has(key));
  if (absent.length) {
    missing += absent.length;
    console.error(
      `${locale} is missing ${absent.length}: ${absent.slice(0, 20).join(', ')}${absent.length > 20 ? ' …' : ''}`,
    );
  }
}
if (missing) process.exit(1);
console.log(`${locales.length} locales, ${all.size} keys each.`);
