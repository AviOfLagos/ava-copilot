import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ARTIFACT_LIMITS, artifactSchema, STUDIO_TOKEN_TTL_MS, VIEW_KEY_TTL_MS } from '@protocol';
import type { Artifact, ArtifactCreateRequest } from '@protocol';
import { privateDir } from '../config';
import { fail } from '../errors';
import type { Logger } from '../log';
import { resolveInside } from '../sandbox/manager';
import type { SandboxManager } from '../sandbox/manager';

/**
 * Things agents make to look at (a landing page, an SVG, an animation), kept on the Mac and shown in an
 * Avi Studio tab. An artifact is a frozen copy: written inline, or built in the agent's sandbox and copied
 * out (regular files only). It is served read-only, from an opaque origin with no network (ARTIFACT_CSP).
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
};

export function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

const MAX_SERVED_BYTES = 25_000_000;

export class ArtifactStore {
  private readonly root: string;

  constructor(private readonly deps: { dataDir: string; sandbox: SandboxManager; log: Logger; now?: () => number }) {
    this.root = privateDir(join(deps.dataDir, 'artifacts'));
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async list(): Promise<Artifact[]> {
    const artifacts: Artifact[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const artifact = await this.get(entry.name);
      if (artifact) artifacts.push(artifact);
    }
    return artifacts.sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  }

  async get(id: string): Promise<Artifact | null> {
    if (!/^[a-f0-9]{16,32}$/.test(id)) return null;
    try {
      const parsed = artifactSchema.safeParse(JSON.parse(await readFile(join(this.root, id, 'meta.json'), 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async create(request: ArtifactCreateRequest): Promise<Artifact> {
    const id = randomBytes(8).toString('hex');
    const dir = join(this.root, id);
    const filesDir = join(dir, 'files');
    await mkdir(filesDir, { recursive: true, mode: 0o700 });
    try {
      let files: string[];
      let bytes: number;
      if (request.files) {
        const entries = Object.entries(request.files);
        bytes = entries.reduce((sum, [, content]) => sum + Buffer.byteLength(content, 'utf8'), 0);
        if (entries.length > ARTIFACT_LIMITS.maxFiles || bytes > ARTIFACT_LIMITS.maxBytes) {
          fail('invalid', `An artifact holds at most ${ARTIFACT_LIMITS.maxFiles} files and 25 MB.`);
        }
        for (const [path, content] of entries) {
          const target = await resolveInside(filesDir, path, true);
          await writeFile(target, content, { mode: 0o600, flag: 'wx' });
        }
        files = entries.map(([path]) => path);
      } else {
        const build = request.build!;
        const result = await this.deps.sandbox.run({ profileId: request.profileId, command: build.command });
        if (result.exitCode !== 0) {
          const tail = result.stderr.trim().split('\n').slice(-5).join('\n');
          fail('invalid', `The build failed (exit ${result.exitCode})${tail ? `:\n${tail}` : '.'}`);
        }
        ({ files, bytes } = await this.deps.sandbox.snapshot(
          request.profileId,
          build.outDir,
          filesDir,
          ARTIFACT_LIMITS,
        ));
      }
      if (!files.includes(request.entry)) fail('invalid', `The artifact has no ${request.entry}.`);
      const wantedExtension = request.kind === 'svg' ? '.svg' : '.html';
      if (request.kind !== 'site' && extname(request.entry).toLowerCase() !== wantedExtension) {
        fail('invalid', `A ${request.kind} artifact starts from a ${wantedExtension} file.`);
      }
      const artifact: Artifact = {
        id,
        title: request.title,
        kind: request.kind,
        entry: request.entry,
        profileId: request.profileId,
        files: files.length,
        bytes,
        createdAt: this.now(),
      };
      await writeFile(join(dir, 'meta.json'), `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
      this.deps.log.info('artifact made', { files: artifact.files, bytes: artifact.bytes, kind: artifact.kind });
      return artifact;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** One file of an artifact, never through a link, never outside its folder. */
  async readFile(id: string, path: string): Promise<{ body: Buffer; contentType: string }> {
    const artifact = await this.get(id);
    if (!artifact) fail('not_found', 'There is no such artifact.');
    const target = await resolveInside(join(this.root, id, 'files'), path, false);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_SERVED_BYTES) fail('not_found', 'There is no such file.');
      return { body: await handle.readFile(), contentType: contentTypeOf(path) };
    } finally {
      await handle.close();
    }
  }
}

const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');

/**
 * Avi Studio's keys. Opening an artifact makes a one-time token (2 minutes) that the extension puts in
 * the Studio address's fragment, so it never reaches a server log or a Referer. The Studio page trades
 * it once for a view key (8 hours) that is part of the artifact's file paths. Neither is the API token.
 */
export class StudioKeys {
  private readonly tokens = new Map<string, { artifactId: string; expiresAt: number }>();
  private readonly viewKeys = new Map<string, { artifactId: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private sweep(): void {
    const now = this.now();
    for (const map of [this.tokens, this.viewKeys]) {
      for (const [key, entry] of map) if (entry.expiresAt < now) map.delete(key);
    }
  }

  issueToken(artifactId: string): string {
    this.sweep();
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(hash(token), { artifactId, expiresAt: this.now() + STUDIO_TOKEN_TTL_MS });
    return token;
  }

  /** A view key for a token that is fresh, unused and for this artifact; null otherwise. Spends the token. */
  redeem(artifactId: string, token: string): string | null {
    this.sweep();
    const key = hash(token);
    const entry = this.tokens.get(key);
    if (!entry) return null;
    this.tokens.delete(key);
    if (entry.artifactId !== artifactId) return null;
    const viewKey = randomBytes(32).toString('base64url');
    this.viewKeys.set(hash(viewKey), { artifactId, expiresAt: this.now() + VIEW_KEY_TTL_MS });
    return viewKey;
  }

  checkView(artifactId: string, viewKey: string): boolean {
    const entry = this.viewKeys.get(hash(viewKey));
    return Boolean(entry && entry.artifactId === artifactId && entry.expiresAt >= this.now());
  }
}
