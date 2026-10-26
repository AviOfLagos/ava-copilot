import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from './helpers';

// Ava Brain.app's launcher (macos/launcher.c): built with the system compiler, run on real processes
const COMPANION = resolve(import.meta.dirname, '../..');
const hasCc = spawnSync('cc', ['--version']).status === 0;
const onMac = process.platform === 'darwin';

const run = (launcher: string, args: string[]) => {
  const child = spawn(launcher, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => (stdout += chunk));
  child.stderr.on('data', chunk => (stderr += chunk));
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
    settle => child.on('close', (code, signal) => settle({ code, signal, stdout, stderr })),
  );
  return { child, done, output: () => stdout };
};

describe.skipIf(!hasCc)('Ava Brain launcher', () => {
  const dir = tempDir();
  const launcher = join(dir.path, 'ava-brain');

  beforeAll(() => {
    execFileSync('cc', ['-O2', '-Wall', '-Werror', '-o', launcher, join(COMPANION, 'macos/launcher.c')]);
  });
  afterAll(() => dir.remove());

  it('runs the program as its child and exits the way it did', async () => {
    expect((await run(launcher, ['/bin/sh', '-c', 'exit 7']).done).code).toBe(7);
    expect((await run(launcher, ['/bin/sh', '-c', 'exit 0']).done).code).toBe(0);
  });

  it('tells Ava Brain which name macOS knows it by', async () => {
    const { stdout } = await run(launcher, ['/bin/sh', '-c', 'printf %s "$AVA_BRAIN_PROGRAM"']).done;
    expect(stdout).toBe('Ava Brain');
  });

  it('stays the parent: the program is a child, not a replacement', async () => {
    const started = run(launcher, ['/bin/sh', '-c', 'echo $PPID']);
    const { stdout } = await started.done;
    expect(Number(stdout.trim())).toBe(started.child.pid);
  });

  it('passes launchd’s stop signal on, so node can shut down cleanly', async () => {
    const started = run(launcher, [
      '/bin/sh',
      '-c',
      'trap "echo stopping; exit 3" TERM; echo ready; while :; do sleep 0.05; done',
    ]);
    while (!started.output().includes('ready')) await new Promise(settle => setTimeout(settle, 20));
    started.child.kill('SIGTERM');
    const result = await started.done;
    expect(result.stdout).toContain('stopping');
    expect(result.code).toBe(3);
  });

  it('dies by the same signal as its child', async () => {
    const result = await run(launcher, ['/bin/sh', '-c', 'kill -KILL $$']).done;
    expect(result.signal).toBe('SIGKILL');
  });

  it('says so when the program cannot start', async () => {
    const result = await run(launcher, [join(dir.path, 'missing')]).done;
    expect(result.code).toBe(127);
    expect(result.stderr).toMatch(/could not start/);
    expect((await run(launcher, []).done).code).toBe(64);
  });
});

describe.skipIf(!onMac || spawnSync('xcode-select', ['-p']).status !== 0)('build-launcher.sh', () => {
  const dir = tempDir();
  afterAll(() => dir.remove());
  const build = () =>
    execFileSync('sh', [join(COMPANION, 'scripts/build-launcher.sh'), dir.path], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();

  it('builds a signed Ava Brain.app for Apple Silicon and Intel', () => {
    const exe = build();
    expect(exe).toBe(join(dir.path, 'Ava Brain.app/Contents/MacOS/ava-brain'));
    const plist = readFileSync(join(dir.path, 'Ava Brain.app/Contents/Info.plist'), 'utf8');
    expect(plist).toContain('<string>com.avicopilot.brain</string>');
    expect(plist).toContain('NSCalendarsFullAccessUsageDescription');
    const signature = spawnSync('codesign', ['-dv', join(dir.path, 'Ava Brain.app')]).stderr.toString();
    expect(signature).toMatch(/Identifier=com\.avicopilot\.brain/);
    expect(signature).toMatch(/Info\.plist entries=/);
    expect(execFileSync('lipo', ['-archs', exe]).toString()).toMatch(/x86_64.*arm64|arm64.*x86_64/);
  });

  it('leaves an app of the same version alone, so macOS keeps its permissions', () => {
    const exe = build();
    const before = statSync(exe);
    expect(build()).toBe(exe);
    const after = statSync(exe);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
