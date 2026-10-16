import { candidateFromFiles, classifyFile, unzipSkillFiles } from '@extension/storage';
import type { SkillCandidate, SkillOriginKind, SkillSourceFile } from '@extension/storage';
import { AppError } from '@extension/shared';

/**
 * Fetching a skill from a link the user chose: a raw Markdown file, a GitHub file, folder or repo holding SKILL.md,
 * a gist, or a zip. Only ever called on the user's click (or their own typed link in a chat): nothing here runs on
 * its own. GitHub is read through its public endpoints without signing in; its hourly limit is reported plainly.
 */

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

// Text larger than this is not a skill
const MAX_TEXT_BYTES = 1_000_000;
const MAX_ZIP_BYTES = 5_000_000;
// Folders of a repo offered at most, when a link holds several skills
const MAX_LISTED = 100;

/** A link that holds several skills: each one's name and its own link, to install one at a time. */
export interface SkillListing {
  name: string;
  url: string;
}

export type FetchedSkill = { type: 'skill'; candidate: SkillCandidate } | { type: 'collection'; items: SkillListing[] };

export type SkillLink =
  | { kind: 'url'; url: string }
  | { kind: 'github'; owner: string; repo: string; ref: string | null; path: string; file: boolean }
  | { kind: 'gist'; id: string };

/**
 * What a link points at.
 *
 * @throws When it is not an http(s) link
 */
export function parseSkillLink(input: string): SkillLink {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new AppError('invalid', 'That is not a link. Paste the address of a skill, e.g. a GitHub folder.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError('invalid', 'Only http and https links can be installed.');
  }
  if (url.username || url.password) throw new AppError('invalid', 'Links with a user name or password are refused.');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const host = url.hostname.toLowerCase();

  if (host === 'github.com' || host === 'www.github.com') {
    const [owner, repo, mode, ref, ...rest] = parts;
    if (!owner || !repo) throw new AppError('invalid', 'That GitHub link names no repository.');
    const name = repo.replace(/\.git$/, '');
    if (!mode) return { kind: 'github', owner, repo: name, ref: null, path: '', file: false };
    if ((mode === 'tree' || mode === 'blob') && ref) {
      return { kind: 'github', owner, repo: name, ref, path: rest.join('/'), file: mode === 'blob' };
    }
    throw new AppError('invalid', 'Link to a GitHub repository, folder or file.');
  }
  if (host === 'raw.githubusercontent.com') {
    const [owner, repo, ref, ...rest] = parts;
    if (!owner || !repo || !ref || !rest.length) throw new AppError('invalid', 'That GitHub link names no file.');
    return { kind: 'github', owner, repo, ref, path: rest.join('/'), file: true };
  }
  if (host === 'gist.github.com' || host === 'gist.githubusercontent.com') {
    // gist.github.com/<user>/<id> or /<id>; raw gist links carry the id second too
    const id = parts.find(part => /^[0-9a-f]{20,}$/i.test(part));
    if (!id) throw new AppError('invalid', 'That gist link has no gist id.');
    return { kind: 'gist', id };
  }
  return { kind: 'url', url: url.href };
}

/** A clear error for a failed response; GitHub's limit for requests without sign-in says when it frees up. */
async function failure(response: Response, what: string): Promise<AppError> {
  const remaining = response.headers.get('x-ratelimit-remaining');
  if (response.status === 429 || (response.status === 403 && remaining === '0')) {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    const at = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null;
    const when = at ? ` Try again after ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : '';
    return new AppError(
      'rate_limit',
      `GitHub's limit for requests without signing in is used up for now.${when} A raw file link still works.`,
      { status: response.status, retryable: false },
    );
  }
  if (response.status === 404) {
    return new AppError('not_found', `${what} was not found. It may be private, moved, or the link mistyped.`, {
      status: 404,
    });
  }
  return new AppError('unavailable', `${what} could not be fetched (HTTP ${response.status}).`, {
    status: response.status,
  });
}

async function get(fetcher: Fetcher, url: string, what: string, signal?: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    // No cookies or sign-in go with it: the skill is read as anyone would read it
    response = await fetcher(url, { credentials: 'omit', redirect: 'follow', signal });
  } catch (error) {
    if (signal?.aborted) throw new AppError('cancelled', 'Stopped.');
    throw new AppError('network', `${what} could not be reached. Check the link and your connection.`, {
      cause: error,
    });
  }
  if (!response.ok) throw await failure(response, what);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_ZIP_BYTES) throw new AppError('invalid', `${what} is too large.`);
  return response;
}

async function text(fetcher: Fetcher, url: string, what: string, signal?: AbortSignal): Promise<string> {
  const body = await (await get(fetcher, url, what, signal)).text();
  if (body.length > MAX_TEXT_BYTES) throw new AppError('invalid', `${what} is too large to be a skill.`);
  return body;
}

const json = async <T>(fetcher: Fetcher, url: string, what: string, signal?: AbortSignal): Promise<T> => {
  const response = await get(fetcher, url, what, signal);
  return (await response.json()) as T;
};

const rawUrl = (owner: string, repo: string, ref: string, path: string) =>
  `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const dirname = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  size?: number;
}

/** A skill (or a list of them) from a GitHub repository, folder or file. */
async function fromGitHub(
  link: Extract<SkillLink, { kind: 'github' }>,
  fetcher: Fetcher,
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<FetchedSkill> {
  const { owner, repo } = link;
  const ref = link.ref ?? 'HEAD';
  const isSkillFile = basename(link.path).toLowerCase() === 'skill.md';

  // A single Markdown file that is not a folder's SKILL.md: just that file
  if (link.file && !isSkillFile) {
    if (classifyFile(link.path) !== 'markdown') {
      throw new AppError('invalid', 'That file is not Markdown. A skill is a .md file or a folder with SKILL.md.');
    }
    const body = await text(fetcher, rawUrl(owner, repo, ref, link.path), 'The file', signal);
    return {
      type: 'skill',
      candidate: await candidateFromFiles([{ path: link.path, text: body }], { url: sourceUrl, kind: 'github' }),
    };
  }

  // A folder, a repo, or a SKILL.md (which stands for its folder): one listing of the whole tree
  const tree = await json<{ tree?: TreeEntry[] }>(
    fetcher,
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    'The repository',
    signal,
  );
  const folder = link.file ? dirname(link.path) : link.path.replace(/\/+$/, '');
  const under = (path: string) => !folder || path.startsWith(`${folder}/`);
  const blobs = (tree.tree ?? []).filter(entry => entry.type === 'blob' && under(entry.path));
  const skillDirs = [
    ...new Set(
      blobs.filter(entry => basename(entry.path).toLowerCase() === 'skill.md').map(entry => dirname(entry.path)),
    ),
  ].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  let dir: string;
  if (skillDirs.includes(folder)) dir = folder;
  else if (skillDirs.length === 1) dir = skillDirs[0];
  else if (skillDirs.length > 1) {
    return {
      type: 'collection',
      items: skillDirs.slice(0, MAX_LISTED).map(path => ({
        name: basename(path) || repo,
        url: `https://github.com/${owner}/${repo}/tree/${ref}/${path}`,
      })),
    };
  } else {
    const markdown = blobs.filter(entry => classifyFile(entry.path) === 'markdown' && dirname(entry.path) === folder);
    if (markdown.length !== 1) {
      throw new AppError('not_found', 'No skill here: this folder has no SKILL.md.');
    }
    dir = folder;
  }

  const inDir = blobs.filter(entry => !dir || entry.path.startsWith(`${dir}/`));
  const files: SkillSourceFile[] = [];
  for (const entry of inDir) {
    if (classifyFile(entry.path) !== 'markdown' || (entry.size ?? 0) > MAX_TEXT_BYTES) {
      files.push({ path: entry.path });
      continue;
    }
    files.push({ path: entry.path, text: await text(fetcher, rawUrl(owner, repo, ref, entry.path), 'A file', signal) });
  }
  const url = link.file || folder === dir ? sourceUrl : `https://github.com/${owner}/${repo}/tree/${ref}/${dir}`;
  return { type: 'skill', candidate: await candidateFromFiles(files, { url, kind: 'github' }) };
}

interface GistFile {
  filename: string;
  content?: string;
  truncated?: boolean;
  raw_url?: string;
}

async function fromGist(id: string, fetcher: Fetcher, sourceUrl: string, signal?: AbortSignal): Promise<FetchedSkill> {
  const gist = await json<{ files?: Record<string, GistFile> }>(
    fetcher,
    `https://api.github.com/gists/${encodeURIComponent(id)}`,
    'The gist',
    signal,
  );
  const files: SkillSourceFile[] = [];
  for (const file of Object.values(gist.files ?? {})) {
    if (classifyFile(file.filename) !== 'markdown') {
      files.push({ path: file.filename });
      continue;
    }
    const body =
      file.truncated && file.raw_url ? await text(fetcher, file.raw_url, 'A file', signal) : (file.content ?? '');
    files.push({ path: file.filename, text: body });
  }
  return { type: 'skill', candidate: await candidateFromFiles(files, { url: sourceUrl, kind: 'gist' }) };
}

async function fromUrl(url: string, fetcher: Fetcher, signal?: AbortSignal): Promise<FetchedSkill> {
  const response = await get(fetcher, url, 'The link', signal);
  const type = response.headers.get('content-type') ?? '';
  const path = new URL(url).pathname;
  let kind: SkillOriginKind = 'url';
  let files: SkillSourceFile[];
  if (/\.zip$/i.test(path) || /zip/i.test(type)) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_ZIP_BYTES) throw new AppError('invalid', 'That zip is too large to be a skill.');
    files = unzipSkillFiles(bytes);
    kind = 'zip';
  } else {
    const body = await response.text();
    if (body.length > MAX_TEXT_BYTES) throw new AppError('invalid', 'That file is too large to be a skill.');
    if (/text\/html/i.test(type) && !/\.(md|markdown)$/i.test(path)) {
      throw new AppError('invalid', 'That link is a web page, not a Markdown file. Use the link to the raw .md file.');
    }
    const name = basename(path) || 'skill.md';
    files = [{ path: /\.(md|markdown)$/i.test(name) ? name : `${name}.md`, text: body }];
  }
  return { type: 'skill', candidate: await candidateFromFiles(files, { url, kind }) };
}

/**
 * Fetches what a link holds. Nothing is saved here: the caller installs it turned off, for review.
 *
 * @throws AppError with a sentence for the user
 */
export async function fetchSkill(
  input: string,
  fetcher: Fetcher = (url, init) => fetch(url, init),
  signal?: AbortSignal,
): Promise<FetchedSkill> {
  const link = parseSkillLink(input);
  const sourceUrl = new URL(input.trim()).href;
  try {
    if (link.kind === 'github') return await fromGitHub(link, fetcher, sourceUrl, signal);
    if (link.kind === 'gist') return await fromGist(link.id, fetcher, sourceUrl, signal);
    return await fromUrl(link.url, fetcher, signal);
  } catch (error) {
    if (AppError.isInstance(error)) throw error;
    // A file that is not a valid skill: parseSkill's sentence says why
    throw new AppError('invalid', error instanceof Error ? error.message : String(error), { cause: error });
  }
}
