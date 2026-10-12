import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SANDBOX_POLICY } from '@protocol';
import { AppError, DOCKER_DOWN_MESSAGE, DOCKER_MISSING_MESSAGE } from '../errors';
import { memoryLogger } from '../log';
import { probeDocker, sandboxRunArgs } from '../sandbox/docker';
import { resolveInside, SandboxManager } from '../sandbox/manager';
import { dockerUp, fakeRunner, tempDir } from './helpers';

const dirs: { remove: () => void }[] = [];
afterEach(() => dirs.splice(0).forEach(dir => dir.remove()));
function dir() {
  const made = tempDir();
  dirs.push(made);
  return made.path;
}

describe('sandboxRunArgs', () => {
  const args = (network: 'none' | 'open') =>
    sandboxRunArgs({
      name: 'avi-brain-a-1',
      profileId: 'a',
      image: 'img',
      workspace: '/Users/me/Library/Application Support/Avi Brain/sandboxes/a/workspace',
      policy: { ...DEFAULT_SANDBOX_POLICY, network, cpus: 2, memoryMb: 512 },
      command: 'echo hi; rm -rf /',
      interactive: false,
    });

  it('locks the container down', () => {
    const list = args('none');
    const pairs = new Map<string, string[]>();
    for (let i = 0; i < list.length - 1; i++) {
      if (list[i].startsWith('--')) pairs.set(list[i], [...(pairs.get(list[i]) ?? []), list[i + 1]]);
    }
    expect(pairs.get('--network')).toEqual(['none']);
    expect(pairs.get('--cpus')).toEqual(['2']);
    expect(pairs.get('--memory')).toEqual(['512m']);
    expect(pairs.get('--memory-swap')).toEqual(['512m']);
    expect(pairs.get('--pids-limit')).toEqual(['256']);
    expect(pairs.get('--cap-drop')).toEqual(['ALL']);
    expect(pairs.get('--security-opt')).toEqual(['no-new-privileges']);
    expect(pairs.get('--user')).toEqual(['1000:1000']);
    expect(list).toContain('--read-only');
    expect(list).toContain('--rm');
    // Only the workspace is mounted, and no variable of the Mac goes in
    expect(pairs.get('--mount')).toEqual([
      'type=bind,source=/Users/me/Library/Application Support/Avi Brain/sandboxes/a/workspace,target=/workspace',
    ]);
    expect(
      list.filter(arg => arg === '-v' || arg === '--volume' || arg === '--privileged' || arg === '--env-file'),
    ).toEqual([]);
    expect(pairs.get('--env')?.every(env => /^(HOME|CI|NO_COLOR|npm_config_cache)=/.test(env))).toBe(true);
    // The command is one argument to sh -lc inside the container, never parsed on the Mac
    expect(list.slice(-4)).toEqual(['img', 'sh', '-lc', 'echo hi; rm -rf /']);
  });

  it('opens the network only when the profile says so', () => {
    expect(args('open')).toContain('bridge');
  });

  it('refuses a workspace Docker would misread', () => {
    expect(() =>
      sandboxRunArgs({
        name: 'n',
        profileId: 'a',
        image: 'i',
        workspace: '/tmp/a,b',
        policy: DEFAULT_SANDBOX_POLICY,
        command: 'x',
        interactive: false,
      }),
    ).toThrow(AppError);
  });
});

describe('probeDocker', () => {
  it('says Docker is down, with what to do', async () => {
    const state = await probeDocker(
      fakeRunner(() => ({ code: 1, stderr: 'Cannot connect to the Docker daemon' })),
      'img',
    );
    expect(state).toEqual({ state: 'down', message: DOCKER_DOWN_MESSAGE, version: null, imageReady: false });
  });

  it('says Docker is missing', async () => {
    const state = await probeDocker(
      fakeRunner(() => new AppError('unavailable', 'docker is not installed')),
      'img',
    );
    expect(state.state).toBe('missing');
    expect(state.message).toBe(DOCKER_MISSING_MESSAGE);
  });

  it('says when the image is not built', async () => {
    const state = await probeDocker(
      fakeRunner(call => (call.args[0] === 'version' ? { stdout: '29.7.0' } : { code: 1 })),
      'img',
    );
    expect(state).toMatchObject({ state: 'up', imageReady: false, version: '29.7.0' });
    expect(state.message).toMatch(/sandbox:build/);
  });
});

describe('SandboxManager', () => {
  it('runs a command and returns its output and exit code', async () => {
    const run = fakeRunner(dockerUp);
    const sandbox = new SandboxManager({ run, image: 'img', dataDir: dir(), log: memoryLogger() });
    const reply = await sandbox.run({ profileId: 'writer', command: 'node -v' });
    expect(reply).toMatchObject({ ok: true, exitCode: 0, stdout: 'ran: node -v\n', timedOut: false });
    const dockerRun = run.calls.find(call => call.args[0] === 'run')!;
    expect(dockerRun.options.timeoutMs).toBe(DEFAULT_SANDBOX_POLICY.timeoutSec * 1000);
  });

  it('refuses to run while Docker is down, with the Docker Desktop message', async () => {
    const sandbox = new SandboxManager({
      run: fakeRunner(() => ({ code: 1 })),
      image: 'img',
      dataDir: dir(),
      log: memoryLogger(),
    });
    await expect(sandbox.run({ profileId: 'writer', command: 'ls' })).rejects.toMatchObject({
      kind: 'unavailable',
      message: DOCKER_DOWN_MESSAGE,
    });
  });

  it('stops a command at its time limit and kills its container', async () => {
    const run = fakeRunner(call => {
      if (call.args[0] === 'run') {
        void call.options.onStop?.();
        return { timedOut: true, code: 137 };
      }
      return dockerUp(call);
    });
    const sandbox = new SandboxManager({ run, image: 'img', dataDir: dir(), log: memoryLogger() });
    const reply = await sandbox.run({ profileId: 'writer', command: 'sleep 999', policy: { timeoutSec: 1 } });
    expect(reply).toMatchObject({ exitCode: 124, timedOut: true });
    expect(run.calls.some(call => call.args[0] === 'kill')).toBe(true);
  });

  it('turns a daemon that went away into the Docker message', async () => {
    const run = fakeRunner(call =>
      call.args[0] === 'run'
        ? { code: 125, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' }
        : dockerUp(call),
    );
    const sandbox = new SandboxManager({ run, image: 'img', dataDir: dir(), log: memoryLogger() });
    await expect(sandbox.run({ profileId: 'writer', command: 'ls' })).rejects.toMatchObject({
      message: DOCKER_DOWN_MESSAGE,
    });
  });

  it('reads and writes workspace files, never through links or out of it', async () => {
    const data = dir();
    const sandbox = new SandboxManager({ run: fakeRunner(dockerUp), image: 'img', dataDir: data, log: memoryLogger() });
    await sandbox.writeFile('writer', 'site/index.html', '<h1>hi</h1>');
    expect(await sandbox.readFile('writer', 'site/index.html')).toBe('<h1>hi</h1>');
    const workspace = sandbox.workspace('writer');
    writeFileSync(join(data, 'secret.txt'), 'outside');
    symlinkSync(join(data, 'secret.txt'), join(workspace, 'leak.txt'));
    mkdirSync(join(workspace, 'real'));
    symlinkSync(data, join(workspace, 'real', 'up'));
    await expect(sandbox.readFile('writer', 'leak.txt')).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(sandbox.readFile('writer', 'real/up/secret.txt')).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(sandbox.readFile('writer', '../secret.txt')).rejects.toMatchObject({ kind: 'invalid' });
    await expect(sandbox.writeFile('writer', 'leak.txt', 'x')).rejects.toMatchObject({ kind: 'forbidden' });
    expect(readFileSync(join(data, 'secret.txt'), 'utf8')).toBe('outside');
    await expect(sandbox.readFile('Bad Id', 'x')).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('copies a built folder without its links', async () => {
    const data = dir();
    const sandbox = new SandboxManager({ run: fakeRunner(dockerUp), image: 'img', dataDir: data, log: memoryLogger() });
    await sandbox.writeFile('writer', 'dist/index.html', 'page');
    await sandbox.writeFile('writer', 'dist/css/site.css', 'body{}');
    writeFileSync(join(data, 'secret.txt'), 'outside');
    symlinkSync(join(data, 'secret.txt'), join(sandbox.workspace('writer'), 'dist', 'leak.txt'));
    const out = join(dir(), 'copy');
    mkdirSync(out);
    const copied = await sandbox.snapshot('writer', 'dist', out, { maxFiles: 10, maxBytes: 1000 });
    expect(copied.files.sort()).toEqual(['css/site.css', 'index.html']);
    await expect(
      sandbox.snapshot('writer', 'dist', join(dir(), 'x'), { maxFiles: 1, maxBytes: 1000 }),
    ).rejects.toMatchObject({
      kind: 'invalid',
    });
  });

  it('resolveInside refuses absolute and dotted paths', async () => {
    const root = dir();
    for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'a//b', 'a\\b', '']) {
      await expect(resolveInside(root, bad, true)).rejects.toMatchObject({ kind: 'invalid' });
    }
  });
});
