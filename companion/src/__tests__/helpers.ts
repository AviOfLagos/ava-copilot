import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMPANION_EXTENSION_ORIGIN } from '@protocol';
import { createBrain } from '../app';
import type { BrainDeps } from '../app';
import type { BrainConfig } from '../config';
import { memoryLogger } from '../log';
import type { ProcessOptions, ProcessResult, ProcessRunner } from '../sandbox/process';
import type { KeyStore } from '../workflows/keys';

export function tempDir(): { path: string; remove: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'avi-brain-test-'));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

export interface FakeCall {
  command: string;
  args: string[];
  options: ProcessOptions;
}

/** A process runner that answers from a script instead of running anything. */
export function fakeRunner(
  answer: (call: FakeCall) => Partial<ProcessResult> | Error,
): ProcessRunner & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const runner = (async (command: string, args: string[], options: ProcessOptions) => {
    const call = { command, args, options };
    calls.push(call);
    const result = answer(call);
    if (result instanceof Error) throw result;
    return {
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      cancelled: false,
      truncated: false,
      durationMs: 1,
      ...result,
    };
  }) as ProcessRunner & { calls: FakeCall[] };
  runner.calls = calls;
  return runner;
}

/** Docker up with the image built; every `docker run` prints what it was asked to run. */
export const dockerUp = (call: FakeCall): Partial<ProcessResult> => {
  if (call.args[0] === 'version') return { stdout: '29.7.0\n' };
  if (call.args[0] === 'image') return { stdout: 'sha256:abc\n' };
  if (call.args[0] === 'run') return { stdout: `ran: ${call.args[call.args.length - 1]}\n` };
  return {};
};

export function memoryKeys(): KeyStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async set(ref, key) {
      values.set(ref, key);
    },
    async get(ref) {
      return values.get(ref) ?? null;
    },
    async delete(ref) {
      values.delete(ref);
    },
  };
}

export function testConfig(dataDir: string): BrainConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    packageDir: dataDir,
    version: '0.0.0-test',
    sandboxImage: 'avi-brain-sandbox:test',
  };
}

/** A started Nex Brain on a free port, with stand-ins, and a fetch that speaks as the extension. */
export async function startTestBrain(deps: BrainDeps = {}) {
  const dir = tempDir();
  const log = memoryLogger();
  const brain = await createBrain(testConfig(dir.path), {
    log,
    run: fakeRunner(dockerUp),
    keys: memoryKeys(),
    engine: null,
    ...deps,
  });
  const port = await brain.start();
  const base = `http://127.0.0.1:${port}`;
  let token = '';
  const api = (path: string, init: RequestInit & { origin?: string | null; token?: string | null } = {}) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    const origin = init.origin === undefined ? COMPANION_EXTENSION_ORIGIN : init.origin;
    if (origin) headers.Origin = origin;
    const bearer = init.token === undefined ? token : init.token;
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    // The API has no GET: an extension's GET carries no Origin
    const method = init.method ?? (path.startsWith('/v1/') ? 'POST' : 'GET');
    const body = init.body ?? (method === 'POST' ? '{}' : undefined);
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(`${base}${path}`, { ...init, method, body, headers });
  };
  const pair = async () => {
    const code = await brain.pairing.createCode();
    const response = await api('/v1/pair', {
      method: 'POST',
      body: JSON.stringify({ code, client: 'test' }),
      token: null,
    });
    const reply = (await response.json()) as { token: string };
    token = reply.token;
    return reply;
  };
  return {
    brain,
    base,
    log,
    api,
    pair,
    async stop() {
      await brain.stop();
      dir.remove();
    },
  };
}
