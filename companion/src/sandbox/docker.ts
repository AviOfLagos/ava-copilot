import type { DockerRuntime, DockerState, SandboxPolicy } from '@protocol';
import { AppError, DOCKER_DOWN_MESSAGE, DOCKER_MISSING_MESSAGE } from '../errors';
import { hostToolEnv } from './process';
import type { ProcessRunner } from './process';

/**
 * Docker through its own command-line tool (as eve does): it finds Docker Desktop, OrbStack or Colima
 * through the user's Docker context, and keeps a gRPC/SSH client library out of the companion. Arguments
 * are always an array, never a shell line.
 */

export const SANDBOX_USER = '1000:1000';
export const SANDBOX_PIDS = 256;
export const SANDBOX_TMP = '/tmp:rw,nosuid,nodev,size=256m';

export interface SandboxRunSpec {
  name: string;
  profileId: string;
  image: string;
  // The profile's workspace on the Mac, mounted at /workspace (the only host path the container sees)
  workspace: string;
  policy: SandboxPolicy;
  command: string;
  interactive: boolean;
}

/**
 * The `docker run` arguments for one command: no network unless the profile allows it; CPU, memory,
 * swap, process and file limits; no capabilities, no privilege gain; a read-only root with a small /tmp;
 * an unprivileged user; nothing from the Mac's environment; only the workspace mounted.
 */
export function sandboxRunArgs(spec: SandboxRunSpec): string[] {
  if (/[,"\n\r]/.test(spec.workspace)) {
    throw new AppError('invalid', 'The sandbox folder has a character Docker cannot mount (comma or quote).');
  }
  return [
    'run',
    '--rm',
    ...(spec.interactive ? ['-i'] : []),
    '--name',
    spec.name,
    '--label',
    'avi-brain=1',
    '--label',
    `avi-brain.profile=${spec.profileId}`,
    '--network',
    spec.policy.network === 'open' ? 'bridge' : 'none',
    '--cpus',
    String(spec.policy.cpus),
    '--memory',
    `${spec.policy.memoryMb}m`,
    '--memory-swap',
    `${spec.policy.memoryMb}m`,
    '--pids-limit',
    String(SANDBOX_PIDS),
    '--ulimit',
    'nofile=1024:1024',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--tmpfs',
    SANDBOX_TMP,
    '--user',
    SANDBOX_USER,
    '--workdir',
    '/workspace',
    '--mount',
    `type=bind,source=${spec.workspace},target=/workspace`,
    '--env',
    'HOME=/workspace/.home',
    '--env',
    'CI=1',
    '--env',
    'NO_COLOR=1',
    '--env',
    'npm_config_cache=/workspace/.home/.npm',
    spec.image,
    'sh',
    '-lc',
    spec.command,
  ];
}

/** Whether Docker answers, and whether the sandbox image is built; with what to do when not. */
export async function probeDocker(run: ProcessRunner, image: string): Promise<DockerState> {
  const env = hostToolEnv();
  let version;
  try {
    version = await run('docker', ['version', '--format', '{{.Server.Version}}'], { env, timeoutMs: 8000 });
  } catch (error) {
    if (AppError.isInstance(error) && error.kind === 'unavailable') {
      return { state: 'missing', message: DOCKER_MISSING_MESSAGE, version: null, imageReady: false };
    }
    throw error;
  }
  if (version.code !== 0 || !version.stdout.trim()) {
    const runtime = await dockerRuntime(run);
    return { state: 'down', message: dockerDownMessage(runtime), version: null, imageReady: false, runtime };
  }
  const inspect = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { env, timeoutMs: 8000 });
  const imageReady = inspect.code === 0;
  return {
    state: 'up',
    message: imageReady
      ? 'Docker is running.'
      : 'Docker is running, but the sandbox image is not built yet. Run `pnpm sandbox:build` in companion/.',
    version: version.stdout.trim().slice(0, 40),
    imageReady,
  };
}

/** Which Docker the user's Docker context points at; null when it is not one Start knows. */
export function runtimeOfContext(name: string): DockerRuntime | null {
  const context = name.trim().toLowerCase();
  if (context.startsWith('colima')) return 'colima';
  if (context === 'orbstack') return 'orbstack';
  if (context === 'desktop-linux' || context === 'default') return 'desktop';
  return null;
}

async function dockerRuntime(run: ProcessRunner): Promise<DockerRuntime | null> {
  try {
    const result = await run('docker', ['context', 'show'], { env: hostToolEnv(), timeoutMs: 5000 });
    return result.code === 0 ? runtimeOfContext(result.stdout) : null;
  } catch {
    return null;
  }
}

/** What to say when Docker does not answer, naming the one this Mac uses. */
export function dockerDownMessage(runtime: DockerRuntime | null): string {
  switch (runtime) {
    case 'colima':
      return 'Docker (Colima) is not running. Press Start Docker, or run `colima start`.';
    case 'orbstack':
      return 'OrbStack is not running. Press Start Docker.';
    case 'desktop':
      return 'Docker Desktop is not running. Press Start Docker.';
    default:
      return DOCKER_DOWN_MESSAGE;
  }
}
