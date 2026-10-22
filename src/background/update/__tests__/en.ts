import fs from 'node:fs';
import path from 'node:path';

// The English messages, with Chrome's $NAME$ placeholders filled from the substitutions, for tests of code that
// builds strings from the user's language (see src/background/skills/__tests__/en.ts, the same idea).
const messages = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../../public/_locales/en/messages.json'), 'utf8'),
) as Record<string, { message: string; placeholders?: Record<string, { content: string }> }>;

export function enT(key: string, substitutions?: string | string[]): string {
  const entry = messages[key];
  if (!entry) return key;
  const values = typeof substitutions === 'string' ? [substitutions] : (substitutions ?? []);
  return entry.message.replace(/\$([A-Z_]+)\$/g, (_match, name: string) => {
    const content = entry.placeholders?.[name.toLowerCase()]?.content ?? '';
    const index = Number(content.replace('$', '')) - 1;
    return values[index] ?? '';
  });
}
