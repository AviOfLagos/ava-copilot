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
import { dirname, isAbsolute } from 'node:path';
import { applyMask, MASK_MARKER, type MaskReport, planMask, secretEntries } from './mask-core';

const MAX_OUTPUT = 400_000;
const MAX_RUN_MS = 15 * 60_000;

/**
 * The text of a stream. When output was cut, a value may be cut with it, and a partial value is not masked; so the
 * last `longest` bytes (longer than any partial value) are dropped first, on both streams.
 */
function captured(chunks: Buffer[], truncated: boolean, longest: number): string {
  const all = Buffer.concat(chunks);
  return (truncated ? all.subarray(0, Math.max(0, all.length - longest)) : all).toString('utf8');
}

function emit(report: MaskReport): void {
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

async function main(): Promise<void> {
  const [, , , command, ...args] = process.argv;
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
  const child = spawn(command, args, { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', keep(out));
  child.stderr.on('data', keep(err));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, MAX_RUN_MS);
  // If Ava Brain gave up (its time limit), offboard-vault is gone and we are orphaned: stop the command too
  const parent = process.ppid;
  const watch = setInterval(() => {
    if (process.ppid !== parent) child.kill('SIGTERM');
  }, 1000);
  const result = await new Promise<{ code: number; signal: string | null; error?: string }>(resolve => {
    child.on('error', error => resolve({ code: 127, signal: null, error: `cannot start the command (${(error as NodeJS.ErrnoException).code ?? 'error'})` }));
    child.on('close', (code, signal) => resolve({ code: code ?? 128, signal }));
  });
  clearTimeout(timer);
  clearInterval(watch);
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

void main();
