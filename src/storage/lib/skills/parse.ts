/**
 * Skills are Markdown files with a small frontmatter block:
 *
 * ---
 * name: gmail
 * description: Writing and finding mail in Gmail
 * match:
 *   urls: ["mail.google.com/*"]
 *   keywords: [gmail, inbox]
 * ---
 * Tips for the agent…
 *
 * `urls` and `keywords` may also sit at the top level. Only this subset of YAML is read: plain and
 * quoted scalars, `|` and `>` block scalars, inline lists, and indented `- item` lists.
 */

export type SkillSource = 'builtin' | 'imported' | 'taught' | 'written';

// Where an installed skill came from: a link (raw file, GitHub, gist) or a file the user dropped
export type SkillOriginKind = 'url' | 'github' | 'gist' | 'file' | 'zip';

export interface SkillOrigin {
  // The link it was fetched from, or the file's name; "Check for update" fetches this again
  url: string;
  kind: SkillOriginKind;
  installedAt: number;
}

// A Markdown file that came with a skill (e.g. reference.md); the agent reads it on request
export interface SkillReference {
  path: string;
  body: string;
}

// A file of the skill that was not installed, and why: code is never run, other files are not Markdown
export interface DroppedSkillFile {
  path: string;
  reason: 'code' | 'other' | 'too_long';
}

export interface SkillRecord {
  // The name as a slug; also what `/name` calls
  id: string;
  name: string;
  description: string;
  urls: string[];
  keywords: string[];
  body: string;
  source: SkillSource;
  enabled: boolean;
  updatedAt: number;
  // Written by someone else (installed from a link or file): it is wrapped as untrusted guidance in the
  // prompt, and it only loads once the user turned on exactly this content (approvedSha256 === sha256)
  trust?: 'external';
  origin?: SkillOrigin;
  // SHA-256 of the content (see skillHash), and of the content the user last turned on
  sha256?: string;
  approvedSha256?: string | null;
  references?: SkillReference[];
  dropped?: DroppedSkillFile[];
}

export interface ParsedSkill {
  name: string;
  description: string;
  urls: string[];
  keywords: string[];
  body: string;
}

// The longest skill body accepted; a skill is a page of tips, not a manual
export const MAX_SKILL_CHARS = 20_000;

/** A skill name as a slug: lowercase letters, digits and dashes. */
export function skillId(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function unquote(value: string): string {
  const text = value.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).replace(/\\"/g, '"');
  }
  return text;
}

/** Splits an inline list on commas outside quotes. */
function inlineList(value: string): string[] {
  const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  const items: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const char of inner) {
    if (quote) {
      if (char === quote) quote = null;
      current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ',') {
      items.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  items.push(current);
  return items.map(unquote).filter(Boolean);
}

type Value = string | string[] | { [key: string]: Value };

/** Reads the frontmatter subset into nested objects. */
export function parseFrontmatter(text: string): Record<string, Value> {
  const lines = text.split('\n').filter(line => line.trim() && !line.trim().startsWith('#'));
  const indentOf = (line: string) => line.length - line.trimStart().length;

  // Reads the lines from `start` that are indented deeper than `parent`, as a mapping
  const mapping = (start: number, parent: number): [Record<string, Value>, number] => {
    const result: Record<string, Value> = {};
    let i = start;
    while (i < lines.length && indentOf(lines[i]) > parent) {
      const indent = indentOf(lines[i]);
      const line = lines[i].trim();
      const colon = line.indexOf(':');
      i += 1;
      if (colon === -1 || line.startsWith('-')) continue;
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (/^[|>][+-]?$/.test(value)) {
        // A block scalar: the more-indented lines below, kept (|) or folded into one line (>)
        const block: string[] = [];
        while (i < lines.length && indentOf(lines[i]) > indent) {
          block.push(lines[i].trim());
          i += 1;
        }
        result[key] = block.join(value.startsWith('|') ? '\n' : ' ');
      } else if (value) {
        result[key] = value.startsWith('[') ? inlineList(value) : unquote(value);
      } else if (i < lines.length && indentOf(lines[i]) > indent && lines[i].trim().startsWith('-')) {
        const items: string[] = [];
        while (i < lines.length && indentOf(lines[i]) > indent && lines[i].trim().startsWith('-')) {
          items.push(unquote(lines[i].trim().slice(1)));
          i += 1;
        }
        result[key] = items.filter(Boolean);
      } else {
        const [child, next] = mapping(i, indent);
        result[key] = child;
        i = next;
      }
    }
    return [result, i];
  };

  return mapping(0, -1)[0];
}

function asList(value: Value | undefined): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string' && value) return value.startsWith('[') ? inlineList(value) : [value];
  return [];
}

/**
 * Reads a skill file.
 *
 * @param fileName - Used for the name when the frontmatter has none
 * @throws When the file has no name and no file name, or no content
 */
export function parseSkill(markdown: string, fileName = ''): ParsedSkill {
  const text = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  const meta = match ? parseFrontmatter(match[1]) : {};
  const body = (match ? match[2] : text).trim();

  const nested = typeof meta.match === 'object' && !Array.isArray(meta.match) ? meta.match : {};
  const name = typeof meta.name === 'string' && meta.name ? meta.name : fileName.replace(/\.(md|markdown|txt)$/i, '');
  if (!skillId(name)) {
    throw new Error('A skill needs a name: add "name:" to its frontmatter.');
  }
  if (!body) {
    throw new Error(`The skill "${name}" has no content.`);
  }
  if (body.length > MAX_SKILL_CHARS) {
    throw new Error(`The skill "${name}" is too long (${body.length} characters; the most is ${MAX_SKILL_CHARS}).`);
  }
  return {
    name,
    description: typeof meta.description === 'string' ? meta.description : '',
    urls: [...asList(nested.urls), ...asList(meta.urls)],
    keywords: [...asList(nested.keywords), ...asList(meta.keywords)],
    body,
  };
}

function yamlString(value: string): string {
  return /^[\w .,/()&-]*$/.test(value) && value.trim() === value ? value : JSON.stringify(value);
}

/** Writes a skill back out as a Markdown file that parseSkill reads. */
export function skillToMarkdown(
  skill: Pick<ParsedSkill, 'name' | 'description' | 'urls' | 'keywords' | 'body'>,
): string {
  const list = (items: string[]) => `[${items.map(item => JSON.stringify(item)).join(', ')}]`;
  return [
    '---',
    `name: ${yamlString(skill.name)}`,
    `description: ${yamlString(skill.description)}`,
    'match:',
    `  urls: ${list(skill.urls)}`,
    `  keywords: ${list(skill.keywords)}`,
    '---',
    '',
    skill.body.trim(),
    '',
  ].join('\n');
}
