import { spawn } from 'node:child_process';
import { AppError } from '../errors';

/**
 * Runs a program without a shell (arguments are never parsed by one), with a time limit, an output cap
 * and a stop signal. Used for `docker` and `gh`; nothing else runs on the host.
 */

export interface ProcessOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes?: number;
  stdin?: string;
  signal?: AbortSignal;
  cwd?: string;
  // Called once when the time limit or the stop signal ends the run (e.g. `docker kill <name>`)
  onStop?: () => Promise<void>;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  durationMs: number;
}

export type ProcessRunner = (command: string, args: string[], options: ProcessOptions) => Promise<ProcessResult>;

const DEFAULT_MAX_OUTPUT = 1_000_000;

export const runProcess: ProcessRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    let child;
    try {
      child = spawn(command, args, {
        env: options.env,
        cwd: options.cwd,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outSize = 0;
    let errSize = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let stopping = false;

    const keep = (into: Buffer[], size: number, chunk: Buffer): number => {
      const room = max - size;
      if (room <= 0) {
        truncated = true;
        return size;
      }
      if (chunk.length > room) truncated = true;
      into.push(chunk.subarray(0, room));
      return size + Math.min(room, chunk.length);
    };
    child.stdout.on('data', (chunk: Buffer) => (outSize = keep(out, outSize, chunk)));
    child.stderr.on('data', (chunk: Buffer) => (errSize = keep(err, errSize, chunk)));

    const stop = () => {
      if (stopping) return;
      stopping = true;
      void (options.onStop?.() ?? Promise.resolve())
        .catch(() => {})
        .finally(() => {
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 3000).unref();
        });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', error => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new AppError('unavailable', `${command} is not installed on this Mac.`, { retryable: false }));
      } else {
        reject(error);
      }
    });
    child.on('close', code => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        cancelled,
        truncated,
        durationMs: Date.now() - started,
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdin ?? '');
  });

/**
 * The environment host tools run with: a PATH that finds Homebrew and Docker Desktop, the user's home,
 * and Docker's own settings. Nothing else of the companion's environment (its secrets) goes along.
 */
export function hostToolEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const path = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/Applications/Docker.app/Contents/Resources/bin',
    `${env.HOME ?? ''}/.orbstack/bin`,
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');
  const kept: NodeJS.ProcessEnv = { PATH: path, HOME: env.HOME, USER: env.USER, LANG: 'en_US.UTF-8', NO_COLOR: '1' };
  for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME']) {
    if (env[name]) kept[name] = env[name];
  }
  return kept;
}
