import { unzipSync } from 'fflate';
import { MAX_SKILL_CHARS, parseSkill } from './parse';
import type { DroppedSkillFile, ParsedSkill, SkillOrigin, SkillRecord, SkillReference } from './parse';

/**
 * Skills written by someone else: the Anthropic Agent Skills format (a folder with SKILL.md, frontmatter `name` and
 * `description`, Markdown, maybe more `.md` files and scripts) mapped onto ours. Only Markdown is kept; a skill's
 * code is never installed. Everything here is pure, so the panel (dropped files) and the background (links) share it.
 */

// Files kept with a skill, and how much of them
export const MAX_REFERENCES = 20;
export const MAX_TOTAL_CHARS = 100_000;
// Past this, the review card says the skill is very long
export const LONG_SKILL_CHARS = 12_000;
// The largest file read out of a zip, and the most read in all (a zip bomb stops here)
const MAX_ZIP_FILE_BYTES = 1_000_000;
const MAX_ZIP_TOTAL_BYTES = 5_000_000;

const MARKDOWN = /\.(md|markdown)$/i;
const CODE =
  /\.(py|pyc|sh|bash|zsh|fish|js|mjs|cjs|ts|tsx|jsx|rb|pl|php|ps1|psm1|bat|cmd|exe|bin|dll|so|dylib|wasm|jar|class|go|rs|c|h|cc|cpp|swift|kt|lua|r|applescript|scpt|command|vbs|html?|svg)$/i;

/** A file of a skill as found: Markdown files carry their text, other files only their path. */
export interface SkillSourceFile {
  path: string;
  text?: string;
}

/** A skill ready for review: what it says, what came with it, where from, and its hash. */
export interface SkillCandidate extends ParsedSkill {
  references: SkillReference[];
  dropped: DroppedSkillFile[];
  origin: Omit<SkillOrigin, 'installedAt'>;
  sha256: string;
}

export function classifyFile(path: string): 'markdown' | 'code' | 'other' {
  if (MARKDOWN.test(path)) return 'markdown';
  // A file under scripts/ or bin/ is code whatever it is called
  if (CODE.test(path) || /(^|\/)(scripts?|bin)\//i.test(path)) return 'code';
  return 'other';
}

const dirname = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const depth = (path: string) => path.split('/').length;

/** The skill's main file: the shallowest SKILL.md, else the only Markdown file, else the shallowest one. */
export function pickMain(paths: string[]): string | null {
  const markdown = paths.filter(path => classifyFile(path) === 'markdown').sort((a, b) => depth(a) - depth(b));
  return (
    markdown.find(path => basename(path).toLowerCase() === 'skill.md') ??
    markdown.find(path => basename(path).toLowerCase() !== 'readme.md') ??
    markdown[0] ??
    null
  );
}

const STOPWORDS = new Set(
  `about above after again against also always another because before being below between both could does doing
  during each every from further have having here into itself just like make more most must only other over same
  should some such than that their them then there these they this those through under until upon used uses using
  very want what when where which while whom with within without would your yours skill skills user users claude
  agent tasks task help helps working work works file files tool tools need needs based including`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Keywords for a skill that has none: its name's words, then the description's longer words, at most five. They
 * only call the skill in when the task uses one of them as a whole word.
 */
export function deriveKeywords(description: string, name: string): string[] {
  const words = [
    ...name.toLowerCase().split(/[^a-z0-9]+/),
    ...description
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(word => word.length >= 4),
  ];
  const kept: string[] = [];
  for (const word of words) {
    if (word.length < 3 || STOPWORDS.has(word) || /^\d+$/.test(word) || kept.includes(word)) continue;
    kept.push(word);
    if (kept.length === 5) break;
  }
  return kept;
}

/** SHA-256 of what a skill says, as hex: the same content always hashes the same. */
export async function skillHash(
  skill: Pick<SkillRecord, 'name' | 'description' | 'urls' | 'keywords' | 'body'> & { references?: SkillReference[] },
): Promise<string> {
  const canonical = JSON.stringify([
    skill.name,
    skill.description,
    skill.urls,
    skill.keywords,
    skill.body,
    (skill.references ?? []).map(reference => [reference.path, reference.body]),
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A skill from its files. The main file decides the folder: Markdown files in it are kept as references, anything
 * else is listed as not installed.
 *
 * @throws When there is no Markdown file, or the main file is not a valid skill
 */
export async function candidateFromFiles(
  files: SkillSourceFile[],
  origin: Omit<SkillOrigin, 'installedAt'>,
): Promise<SkillCandidate> {
  const usable = files.filter(
    file => !/(^|\/)(__MACOSX|\.git)\//.test(file.path) && !basename(file.path).startsWith('.'),
  );
  const mainPath = pickMain(usable.filter(file => file.text !== undefined).map(file => file.path));
  if (!mainPath) throw new Error('No skill here: there is no SKILL.md or other Markdown file.');
  const root = dirname(mainPath);
  const inRoot = (path: string) => !root || path.startsWith(`${root}/`);
  const relative = (path: string) => (root ? path.slice(root.length + 1) : path);
  const main = usable.find(file => file.path === mainPath)!;

  const nameHint = basename(mainPath).toLowerCase() === 'skill.md' && root ? basename(root) : basename(mainPath);
  const parsed = parseSkill(main.text ?? '', nameHint);
  const keywords = parsed.keywords.length ? parsed.keywords : deriveKeywords(parsed.description, parsed.name);

  const references: SkillReference[] = [];
  const dropped: DroppedSkillFile[] = [];
  let total = parsed.body.length;
  for (const file of usable) {
    if (file.path === mainPath || !inRoot(file.path)) continue;
    const path = relative(file.path);
    const kind = classifyFile(file.path);
    if (kind !== 'markdown' || file.text === undefined) {
      dropped.push({ path, reason: kind === 'code' ? 'code' : 'other' });
      continue;
    }
    const body = file.text
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .trim();
    if (!body) continue;
    if (body.length > MAX_SKILL_CHARS || references.length >= MAX_REFERENCES || total + body.length > MAX_TOTAL_CHARS) {
      dropped.push({ path, reason: 'too_long' });
      continue;
    }
    total += body.length;
    references.push({ path, body });
  }
  references.sort((a, b) => a.path.localeCompare(b.path));
  dropped.sort((a, b) => a.path.localeCompare(b.path));

  const skill = { ...parsed, keywords, references };
  return { ...skill, dropped, origin, sha256: await skillHash(skill) };
}

/**
 * The files of a zipped skill folder. Only Markdown files are unpacked; the others are named so the review can
 * say they were left out.
 *
 * @throws When the zip cannot be read or holds too much
 */
export function unzipSkillFiles(bytes: Uint8Array): SkillSourceFile[] {
  const named: string[] = [];
  let total = 0;
  let unpacked: Record<string, Uint8Array>;
  try {
    unpacked = unzipSync(bytes, {
      filter: file => {
        if (file.name.endsWith('/')) return false;
        named.push(file.name);
        if (classifyFile(file.name) !== 'markdown' || file.originalSize > MAX_ZIP_FILE_BYTES) return false;
        total += file.originalSize;
        return total <= MAX_ZIP_TOTAL_BYTES;
      },
    });
  } catch (error) {
    throw new Error('That zip could not be read.', { cause: error });
  }
  if (total > MAX_ZIP_TOTAL_BYTES) throw new Error('That zip holds too much text to be a skill.');
  const decoder = new TextDecoder();
  return named.map(path => (path in unpacked ? { path, text: decoder.decode(unpacked[path]) } : { path }));
}

// ── Review ────────────────────────────────────────────────────────────────────────────────────────

export type SkillRedFlag = 'actions' | 'credentials' | 'outside_urls' | 'hidden' | 'override' | 'long';

// Zero-width and direction-changing characters, and Unicode tag characters: text a reader cannot see
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;

/** The text without characters a reader cannot see. */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, '');
}

/** The text with each character a reader cannot see shown as its code, e.g. ⟨U+200B⟩, for the review. */
export function revealInvisible(text: string): string {
  return text.replace(
    INVISIBLE,
    char => `⟨U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟩`,
  );
}

/** The hosts a skill's own URL patterns name, e.g. "app.example.com" for "*.app.example.com/*". */
function ownHosts(patterns: string[]): string[] {
  return patterns
    .map(pattern =>
      pattern
        .trim()
        .replace(/^[a-z*]+:\/\//i, '')
        .split('/')[0]
        .replace(/^\*\./, '')
        .replace(/:.*$/, '')
        .toLowerCase(),
    )
    .filter(host => host && !host.includes('*'));
}

/** The URLs a text links to whose host is not one of the skill's own sites, nor where it came from. */
export function outsideUrls(text: string, patterns: string[], sourceUrl = ''): string[] {
  const hosts = ownHosts(patterns);
  try {
    if (sourceUrl) hosts.push(new URL(sourceUrl).hostname.toLowerCase());
  } catch {
    // A file name, not a link
  }
  const found = new Set<string>();
  for (const [url] of text.matchAll(/https?:\/\/[^\s)<>\]"'`]+/gi)) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (!hosts.some(own => host === own || host.endsWith(`.${own}`))) found.add(url.replace(/[.,;:!?]+$/, ''));
    } catch {
      // Not a URL after all
    }
  }
  return [...found];
}

/**
 * What a reader should look at twice before turning a skill on: it tells the agent to send, post, delete or buy;
 * it mentions passwords or tokens; it links outside its own sites; it hides text; it tries to change the rules;
 * it is very long. A warning, not a verdict: the gate stops every commit whatever a skill says.
 */
export function skillRedFlags(
  skill: Pick<SkillRecord, 'description' | 'urls' | 'body'> & { references?: SkillReference[] },
  sourceUrl = '',
): SkillRedFlag[] {
  const text = [skill.description, skill.body, ...(skill.references ?? []).map(reference => reference.body)].join('\n');
  const flags: SkillRedFlag[] = [];
  if (
    /\b(send|post|submit|delete|remove|buy|purchase|pay|checkout|transfer|wire|publish|share|invite|grant)\b/i.test(
      text,
    )
  )
    flags.push('actions');
  if (
    /\b(passwords?|passcodes?|passphrases?|tokens?|api[ _-]?keys?|secrets?|credentials?|private[ _-]keys?|seed phrase|2fa|otp|one-time code|cookies?|session ids?)\b/i.test(
      text,
    )
  )
    flags.push('credentials');
  if (outsideUrls(text, skill.urls, sourceUrl).length) flags.push('outside_urls');
  if (new RegExp(INVISIBLE.source, 'u').test(text) || /<!--|display\s*:\s*none|visibility\s*:\s*hidden/i.test(text))
    flags.push('hidden');
  if (
    /\b(ignore (all |any )?(previous|prior|earlier|above|other) (instructions|rules)|disregard (the|your|all) (rules|instructions)|without (asking|confirm(ation|ing)?)|(skip|bypass|disable) (the )?(confirm(ation)?|gate|review|approval)|do not ask (the user|for confirmation)|you are now|system prompt)\b/i.test(
      text,
    )
  )
    flags.push('override');
  if (text.length > LONG_SKILL_CHARS) flags.push('long');
  return flags;
}

// ── Updates ───────────────────────────────────────────────────────────────────────────────────────

export interface DiffLine {
  op: 'same' | 'add' | 'del';
  text: string;
}

// Past this many cells the diff is not worked out line by line: the old text is shown removed and the new added
const MAX_DIFF_CELLS = 4_000_000;

/** A line diff of two texts (longest common subsequence). */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return [...a.map(text => ({ op: 'del' as const, text })), ...b.map(text => ({ op: 'add' as const, text }))];
  }
  // lengths[i][j]: the longest common run of a[i..] and b[j..]
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ op: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      lines.push({ op: 'del', text: a[i++] });
    } else {
      lines.push({ op: 'add', text: b[j++] });
    }
  }
  while (i < a.length) lines.push({ op: 'del', text: a[i++] });
  while (j < b.length) lines.push({ op: 'add', text: b[j++] });
  return lines;
}

/** A skill's whole text, main file then references, as the review and the update diff show it. */
export function skillFullText(skill: Pick<SkillRecord, 'body'> & { references?: SkillReference[] }): string {
  return [skill.body, ...(skill.references ?? []).map(reference => `\n## ${reference.path}\n\n${reference.body}`)].join(
    '\n',
  );
}

/** Characters in a skill, main file and references together. */
export function skillSize(skill: Pick<SkillRecord, 'body'> & { references?: SkillReference[] }): number {
  return skill.body.length + (skill.references ?? []).reduce((sum, reference) => sum + reference.body.length, 0);
}
