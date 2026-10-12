import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { abortableSleep } from '@extension/shared';
import type { SessionEvent } from '@protocol';
import { AppError, fail, toAppError } from '../errors';
import type { Logger } from '../log';
import { redact } from '../log';
import { hostToolEnv } from '../sandbox/process';
import { mapEveEvent, ndjson } from './events';

/**
 * Agent sessions run by Vercel eve (see SPIKE.md). Avi Brain starts `eve start` on a random loopback
 * port and is the only one who talks to it:
 * - eve's routes accept only a per-boot secret (agent/channels/eve.ts), and no browser Origin;
 * - the agent asks Avi Brain's internal API for its profile, model and tools (agent/lib/avi-brain.ts), so
 *   keys never enter eve's durable store;
 * - telemetry is off for every eve command; eve's store is made private (0700).
 * The extension never sees eve: it speaks the protocol, and this class translates.
 */

export interface EngineState {
  kind: 'eve' | 'none';
  state: 'ready' | 'starting' | 'down' | 'off';
  message: string | null;
}

export interface SessionEngine {
  state(): EngineState;
  start(): Promise<void>;
  stop(): Promise<void>;
  create(profileId: string, message: string): Promise<string>;
  send(sessionId: string, message: string): Promise<void>;
  answer(sessionId: string, approvalId: string, approved: boolean, note?: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  events(sessionId: string, cursor: number, signal: AbortSignal): AsyncIterable<SessionEvent>;
}

export interface EveEngineOptions {
  packageDir: string;
  log: Logger;
  internalUrl: () => string;
  internalSecret: string;
  fetch?: typeof fetch;
  spawnEve?: (bin: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;
}

const START_TIMEOUT_MS = 60_000;
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 10 * 60_000;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (!address || typeof address !== 'object') throw new Error('No free port');
  return address.port;
}

export class EveEngine implements SessionEngine {
  private child: ChildProcess | null = null;
  private base: string | null = null;
  private readonly secret = randomBytes(32).toString('base64url');
  private current: EngineState = { kind: 'eve', state: 'off', message: null };
  private stopping = false;
  private restarts: number[] = [];
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: EveEngineOptions) {
    this.doFetch = options.fetch ?? fetch;
  }

  state(): EngineState {
    return this.current;
  }

  async start(): Promise<void> {
    this.stopping = false;
    const bin = join(this.options.packageDir, 'node_modules', '.bin', 'eve');
    if (!existsSync(bin)) {
      this.current = { kind: 'eve', state: 'off', message: 'eve is not installed: run `pnpm install` in companion/.' };
      return;
    }
    if (!existsSync(join(this.options.packageDir, '.output'))) {
      this.current = {
        kind: 'eve',
        state: 'off',
        message: 'The agent is not built yet: run `pnpm build:agent` in companion/.',
      };
      return;
    }
    this.current = { kind: 'eve', state: 'starting', message: null };
    const port = await freePort();
    const spawnEve = this.options.spawnEve ?? spawn;
    const child = spawnEve(bin, ['start', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: this.options.packageDir,
      env: {
        ...hostToolEnv(),
        NODE_ENV: 'production',
        // Every eve command reports usage to Vercel unless told not to
        EVE_TELEMETRY_DISABLED: '1',
        AVI_BRAIN_EVE_SECRET: this.secret,
        AVI_BRAIN_INTERNAL_URL: this.options.internalUrl(),
        AVI_BRAIN_INTERNAL_SECRET: this.options.internalSecret,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) this.options.log.debug('eve', { line: redact(line).slice(0, 300) });
      }
    };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);
    child.on('exit', code => {
      if (this.child !== child) return;
      this.child = null;
      this.base = null;
      if (this.stopping) return;
      this.current = { kind: 'eve', state: 'down', message: `The agent engine stopped (exit ${code ?? 'signal'}).` };
      this.options.log.warn('eve stopped', { code: code ?? -1 });
      const now = Date.now();
      this.restarts = [...this.restarts.filter(at => now - at < RESTART_WINDOW_MS), now];
      if (this.restarts.length <= MAX_RESTARTS) {
        setTimeout(() => void this.start().catch(() => {}), 2000 * this.restarts.length).unref();
      }
    });

    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline && this.child === child) {
      const up = await this.doFetch(`${base}/eve/v1/health`).then(
        response => response.ok,
        () => false,
      );
      if (up) {
        this.base = base;
        this.current = { kind: 'eve', state: 'ready', message: null };
        await chmod(join(this.options.packageDir, '.eve'), 0o700).catch(() => {});
        await chmod(join(this.options.packageDir, '.eve', '.workflow-data'), 0o700).catch(() => {});
        this.options.log.info('eve ready');
        return;
      }
      await abortableSleep(250);
    }
    if (this.child === child) {
      this.current = { kind: 'eve', state: 'down', message: 'The agent engine did not start in time.' };
      child.kill('SIGTERM');
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    this.base = null;
    this.current = { kind: 'eve', state: 'off', message: null };
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  private ready(): string {
    if (!this.base) fail('unavailable', this.current.message ?? 'The agent engine is starting; try again in a moment.');
    return this.base;
  }

  private headers(profileId?: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.secret}`,
      'Content-Type': 'application/json',
      ...(profileId ? { 'x-avi-profile': profileId } : {}),
    };
  }

  /** A POST to eve, retried while the session's inbox is still opening (409 session_not_ready). */
  private async post(path: string, body: unknown, profileId?: string): Promise<Record<string, unknown>> {
    const base = this.ready();
    for (let attempt = 0; ; attempt++) {
      const response = await this.doFetch(`${base}${path}`, {
        method: 'POST',
        headers: this.headers(profileId),
        body: JSON.stringify(body ?? {}),
      }).catch(error => {
        throw toAppError(error);
      });
      const reply = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.ok) return reply;
      if (response.status === 409 && reply.code === 'session_not_ready' && attempt < 40) {
        await abortableSleep(500);
        continue;
      }
      if (response.status === 409) fail('invalid', 'That session has ended. Start a new one.');
      if (response.status === 404) fail('not_found', 'There is no such session.');
      fail(response.status >= 500 ? 'unavailable' : 'invalid', 'The agent engine refused the request.');
    }
  }

  async create(profileId: string, message: string): Promise<string> {
    const reply = await this.post('/eve/v1/session', { message }, profileId);
    if (typeof reply.sessionId !== 'string') fail('unavailable', 'The agent engine did not start a session.');
    return reply.sessionId;
  }

  async send(sessionId: string, message: string): Promise<void> {
    await this.post(`/eve/v1/session/${encodeURIComponent(sessionId)}`, { message });
  }

  async answer(sessionId: string, approvalId: string, approved: boolean, note?: string): Promise<void> {
    await this.post(`/eve/v1/session/${encodeURIComponent(sessionId)}`, {
      inputResponses: [
        {
          requestId: approvalId,
          optionId: approved ? 'approve' : 'cancel',
          ...(!approved && note ? { text: note } : {}),
        },
      ],
    });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.post(`/eve/v1/session/${encodeURIComponent(sessionId)}/cancel`, {});
  }

  async *events(sessionId: string, cursor: number, signal: AbortSignal): AsyncGenerator<SessionEvent> {
    const base = this.ready();
    const response = await this.doFetch(
      `${base}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=${Math.max(0, Math.floor(cursor))}`,
      { headers: this.headers(), signal },
    ).catch(error => {
      throw toAppError(error);
    });
    if (response.status === 404) throw new AppError('not_found', 'There is no such session.');
    if (!response.ok || !response.body) throw new AppError('unavailable', 'The session stream is not available.');
    let index = Math.max(0, Math.floor(cursor));
    for await (const raw of ndjson(response.body as unknown as AsyncIterable<Uint8Array>)) {
      const mapped = mapEveEvent(raw, index);
      index++;
      if (mapped) yield mapped;
    }
  }
}
