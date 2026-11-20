/**
 * The Ava Keys masker: the command `offboard-vault run` starts after Avi's Touch ID. It is the only Ava code that
 * ever holds secret values (they are in its environment). It runs the real command, captures its output, masks
 * every value and prints one JSON object with the masked text. Values never leave this process unmasked.
 *
 *   mask "<agent>: <purpose>" /absolute/command [args...]
 *
 * The first argument is only there so the approval prompt shows who asked and why; it is not used.
 * Built to dist/ava-keys-mask.mjs and installed as ~/.ava-keys/mask (see ./install.ts).
 */
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { applyMask, MASK_MARKER, type MaskReport, planMask, secretEntries } from './mask-core';

const MAX_OUTPUT = 400_000;
// Longer than Ava Brain's own limit (30 min, approval included), which stops us first through the parent watch
const MAX_RUN_MS = 31 * 60_000;

/**
 * The text of a stream. When output was cut, a value may be cut with it, and a partial value is not masked; so the
 * last `longest` bytes (longer than any partial value) are dropped first, on both streams.
 */
function captured(chunks: Buffer[], truncated: boolean, longest: number): string {
  const all = Buffer.concat(chunks);
  return (truncated ? all.subarray(0, Math.max(0, all.length - longest)) : all).toString('utf8');
}

function emit(report: MaskReport): void {
  // Synchronous: stdout is a pipe (asynchronous on macOS) and the process exits right after
  writeSync(1, `${JSON.stringify(report)}\n`);
}

async function main(): Promise<void> {
  const [, , , command, ...args] = process.argv;
  // First line: proof the command is about to start, so Ava Brain never reports "nothing ran" when something did
  writeSync(1, `${JSON.stringify({ marker: MASK_MARKER, started: true })}\n`);
  const plan = planMask(secretEntries(process.env));
  const masked: Record<string, number> = {};
  const base: MaskReport = {
    marker: MASK_MARKER,
    exitCode: 127,
    signal: null,
    stdout: '',
    stderr: '',
    masked,
    unmasked: plan.unmasked,
    truncated: false,
    timedOut: false,
  };
  if (!command || !isAbsolute(command)) {
    emit({ ...base, error: 'the masker needs an absolute command path' });
    process.exitCode = 2;
    return;
  }
  // offboard-vault gives a fixed system PATH; the command also gets its own folder and this node's folder, so
  // `#!/usr/bin/env node` scripts (pnpm, vercel) find node
  const env = {
    ...process.env,
    PATH: [dirname(command), dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
  };
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let size = 0;
  let truncated = false;
  const keep = (into: Buffer[]) => (chunk: Buffer) => {
    if (size >= MAX_OUTPUT) {
      truncated = true;
      return;
    }
    const part = chunk.subarray(0, MAX_OUTPUT - size);
    if (part.length < chunk.length) truncated = true;
    size += part.length;
    into.push(part);
  };
  // Its own process group, so a timeout or Ava Brain giving up stops grandchildren (which hold the secrets) too
  const child = spawn(command, args, { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.on('data', keep(out));
  child.stderr.on('data', keep(err));
  const stopGroup = () => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      return; // already gone
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // gone
      }
    }, 3000).unref();
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stopGroup();
  }, MAX_RUN_MS);
  // If Ava Brain gave up (its time limit), offboard-vault is gone and we are orphaned: stop the command too
  const parent = process.ppid;
  const watch = setInterval(() => {
    if (process.ppid !== parent) stopGroup();
  }, 1000);
  const result = await new Promise<{ code: number; signal: string | null; error?: string }>(resolve => {
    child.on('error', error => resolve({ code: 127, signal: null, error: `cannot start the command (${(error as NodeJS.ErrnoException).code ?? 'error'})` }));
    // On exit, not close: a daemon the command left behind may hold the pipes open forever. Give the pipes a moment
    // to drain, then go on.
    child.on('exit', (code, signal) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve({ code: code ?? 128, signal });
      };
      child.on('close', finish);
      setTimeout(finish, 2000).unref();
    });
  });
  clearTimeout(timer);
  clearInterval(watch);
  // Nothing the command started may outlive it with the secrets in its environment
  stopGroup();
  emit({
    ...base,
    exitCode: result.code,
    signal: result.signal,
    stdout: applyMask(captured(out, truncated, plan.longest), plan, masked),
    stderr: applyMask(captured(err, truncated, plan.longest), plan, masked),
    truncated,
    timedOut,
    ...(result.error ? { error: result.error } : {}),
  });
  process.exitCode = result.code;
}

// Never throw raw: node's own error text can quote environment values. Exit as soon as the report is written.
main()
  .catch(() => {
    emit({ marker: MASK_MARKER, exitCode: 70, signal: null, stdout: '', stderr: '', masked: {}, unmasked: [], truncated: false, timedOut: false, error: 'the masker failed (details withheld: they may contain values)' });
    process.exitCode = 70;
  })
  .finally(() => process.exit());
