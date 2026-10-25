import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_SANDBOX_POLICY, DOCKER_START_TIMEOUT_MS, isSafeRelativePath, sandboxPolicySchema } from '@protocol';
import type { DockerState, SandboxPolicy, SandboxRunReply } from '@protocol';
import { privateDir } from '../config';
import { AppError, DOCKER_DOWN_MESSAGE, fail } from '../errors';
import type { Logger } from '../log';
import { probeDocker, sandboxRunArgs } from './docker';
import { hostToolEnv } from './process';
import type { ProcessRunner } from './process';

/**
 * One sandbox per agent profile: a workspace folder on the Mac, mounted into a fresh, locked-down
 * container for each command (`docker run --rm`), so limits apply to every run and nothing lingers.
 * Commands and file work for one profile run one at a time; the companion only touches a workspace while
 * no container of that profile runs, so a container cannot swap a file for a link under it.
 */

export const MAX_OUTPUT_BYTES = 1_000_000;
export const MAX_READ_BYTES = 1_000_000;
export const MAX_WRITE_BYTES = 2_000_000;
const DOCKER_CACHE_MS = 10_000;
const DOCKER_START_POLL_MS = 2000;

export interface RunRequest {
  profileId: string;
  command: string;
  policy?: Partial<SandboxPolicy>;
  stdin?: string;
  signal?: AbortSignal;
}

export class SandboxManager {
  private readonly locks = new Map<string, Promise<unknown>>();
  private dockerCache: { at: number; state: DockerState } | null = null;

  constructor(
    private readonly deps: {
      run: ProcessRunner;
      image: string;
      dataDir: string;
      log: Logger;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Docker's state, checked at most every 10 s unless asked fresh. */
  async docker(fresh = false): Promise<DockerState> {
    if (!fresh && this.dockerCache && this.now() - this.dockerCache.at < DOCKER_CACHE_MS) return this.dockerCache.state;
    const state = await probeDocker(this.deps.run, this.deps.image);
    this.dockerCache = { at: this.now(), state };
    return state;
  }

  /** Starts the Docker this Mac uses (Colima, Docker Desktop or OrbStack) and waits until it answers. */
  async startDocker(): Promise<DockerState> {
    const before = await this.docker(true);
    if (before.state !== 'down') return before;
    const env = hostToolEnv();
    if (before.runtime === 'colima') {
      const result = await this.deps.run('colima', ['start'], { env, timeoutMs: DOCKER_START_TIMEOUT_MS - 10_000 });
      if (result.code !== 0) fail('unavailable', 'Colima did not start. Run `colima start` in a terminal to see why.');
    } else {
      const app = before.runtime === 'orbstack' ? 'OrbStack' : 'Docker';
      const result = await this.deps.run('/usr/bin/open', ['-a', app], { env, timeoutMs: 15_000 });
      if (result.code !== 0)
        fail('unavailable', `${app === 'Docker' ? 'Docker Desktop' : app} is not installed on this Mac.`);
    }
    // An app is up a little after it opens; Colima answers as soon as its start returns
    const deadline = this.now() + DOCKER_START_TIMEOUT_MS - 20_000;
    for (;;) {
      const state = await this.docker(true);
      if (state.state === 'up' || this.now() >= deadline) return state;
      await new Promise(resolve => setTimeout(resolve, DOCKER_START_POLL_MS));
    }
  }

  workspace(profileId: string): string {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profileId)) fail('invalid', 'That agent id cannot name a sandbox.');
    return privateDir(join(this.deps.dataDir, 'sandboxes', profileId, 'workspace'));
  }

  /** Runs work for one profile after any work already queued for it. */
  private serial<T>(profileId: string, work: () => Promise<T>): Promise<T> {
    const before = this.locks.get(profileId) ?? Promise.resolve();
    const next = before.then(work, work);
    const settled = next.catch(() => {});
    this.locks.set(profileId, settled);
    void settled.then(() => {
      if (this.locks.get(profileId) === settled) this.locks.delete(profileId);
    });
    return next;
  }

  /** One shell command line in the profile's sandbox. Its exit code is the command's own. */
  async run(request: RunRequest): Promise<SandboxRunReply> {
    const policy = sandboxPolicySchema.parse({ ...DEFAULT_SANDBOX_POLICY, ...request.policy });
    const workspace = this.workspace(request.profileId);
    return this.serial(request.profileId, async () => {
      const docker = await this.docker();
      if (docker.state !== 'up' || !docker.imageReady) fail('unavailable', docker.message);
      const name = `avi-brain-${request.profileId}-${randomBytes(4).toString('hex')}`;
      const env = hostToolEnv();
      const args = sandboxRunArgs({
        name,
        profileId: request.profileId,
        image: this.deps.image,
        workspace,
        policy,
        command: request.command,
        interactive: request.stdin !== undefined,
      });
      const result = await this.deps.run('docker', args, {
        env,
        timeoutMs: policy.timeoutSec * 1000,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        stdin: request.stdin,
        signal: request.signal,
        onStop: async () => {
          await this.deps.run('docker', ['kill', name], { env, timeoutMs: 10_000 }).catch(() => undefined);
        },
      });
      if (result.cancelled) throw new AppError('cancelled', 'Stopped.');
      // 125: docker itself could not run the container (the daemon went away, a bad option)
      if (result.code === 125 && !result.timedOut) {
        this.dockerCache = null;
        const daemonDown = /Cannot connect to the Docker daemon|docker daemon is not running/i.test(result.stderr);
        this.deps.log.warn('sandbox did not start', { profile: request.profileId, daemonDown });
        fail('unavailable', daemonDown ? DOCKER_DOWN_MESSAGE : 'Docker could not start the sandbox.');
      }
      this.deps.log.info('sandbox run', {
        profile: request.profileId,
        exit: result.code,
        ms: result.durationMs,
        timedOut: result.timedOut,
      });
      return {
        ok: true,
        exitCode: result.timedOut ? 124 : result.code,
        stdout: result.stdout,
        stderr: result.timedOut ? `${result.stderr}\n[Stopped after ${policy.timeoutSec} s]`.trim() : result.stderr,
        timedOut: result.timedOut,
        truncated: result.truncated,
        durationMs: result.durationMs,
      };
    });
  }

  /** A text file from the profile's workspace. */
  async readFile(profileId: string, path: string): Promise<string> {
    const root = this.workspace(profileId);
    return this.serial(profileId, async () => {
      const target = await resolveInside(root, path, false);
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) fail('invalid', `${path} is not a file.`);
        if (stat.size > MAX_READ_BYTES) fail('invalid', `${path} is larger than 1 MB.`);
        const text = (await handle.readFile()).toString('utf8');
        if (text.includes('\u0000')) fail('invalid', `${path} is not a text file.`);
        return text;
      } finally {
        await handle.close();
      }
    });
  }

  /** Writes a text file into the profile's workspace, making its folders. */
  async writeFile(profileId: string, path: string, content: string): Promise<{ bytes: number }> {
    const root = this.workspace(profileId);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_WRITE_BYTES) fail('invalid', 'The file is larger than 2 MB.');
    return this.serial(profileId, async () => {
      const target = await resolveInside(root, path, true);
      await writeFile(target, content, {
        mode: 0o600,
        flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      });
      return { bytes };
    });
  }

  /** Copies a folder of the workspace elsewhere: regular files only, links skipped, within the limits. */
  async snapshot(
    profileId: string,
    dir: string,
    destination: string,
    limits: { maxFiles: number; maxBytes: number },
  ): Promise<{ files: string[]; bytes: number }> {
    const root = this.workspace(profileId);
    return this.serial(profileId, async () => {
      const source = await resolveInside(root, dir, false);
      if (!(await lstat(source)).isDirectory()) fail('invalid', `${dir} is not a folder.`);
      const files: string[] = [];
      let bytes = 0;
      const walk = async (from: string, relative: string): Promise<void> => {
        for (const entry of await readdir(from, { withFileTypes: true })) {
          const inner = relative ? `${relative}/${entry.name}` : entry.name;
          const full = join(from, entry.name);
          if (entry.isDirectory()) {
            await walk(full, inner);
          } else if (entry.isFile()) {
            const stat = await lstat(full);
            if (!stat.isFile()) continue;
            if (!isSafeRelativePath(inner)) continue;
            bytes += stat.size;
            if (files.length + 1 > limits.maxFiles || bytes > limits.maxBytes) {
              fail(
                'invalid',
                `The output is larger than ${limits.maxFiles} files or ${Math.round(limits.maxBytes / 1_000_000)} MB.`,
              );
            }
            const target = join(destination, ...inner.split('/'));
            await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
            await copyFile(full, target, constants.COPYFILE_EXCL);
            files.push(inner);
          }
          // Links, sockets and devices are never copied
        }
      };
      await walk(source, '');
      return { files, bytes };
    });
  }
}

/**
 * A path inside `root` for a relative path, refusing "..", absolute paths and any link on the way.
 * With `create`, missing folders are made.
 */
export async function resolveInside(root: string, relative: string, create: boolean): Promise<string> {
  if (!isSafeRelativePath(relative)) fail('invalid', `"${relative}" is not a path inside the workspace.`);
  const parts = relative.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const last = index === parts.length - 1;
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) fail('not_found', `${relative} does not exist.`);
      if (!last) await mkdir(current, { mode: 0o700 });
      continue;
    }
    if (stat.isSymbolicLink()) fail('forbidden', `${relative} goes through a link; links are not followed.`);
    if (!last && !stat.isDirectory()) fail('invalid', `${parts.slice(0, index + 1).join('/')} is not a folder.`);
  }
  return current;
}
