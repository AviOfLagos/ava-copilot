import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { COMPANION_EXTENSION_ORIGIN } from '@protocol';
import { bearerToken, sameSecret } from '../auth/pairing';
import type { PairingStore } from '../auth/pairing';
import { AppError, errorReply, fail } from '../errors';
import type { Logger } from '../log';
import { RateLimiter } from './ratelimit';
import type { RateGroup } from './ratelimit';

/**
 * Avi Brain's HTTP server: bound to 127.0.0.1 only, and closed unless a request proves who it is.
 *
 * - every request must name this server in its Host header (no DNS rebinding);
 * - `api` routes need the extension's Origin and the paired bearer token (401/403 otherwise);
 * - `pair` needs the extension's Origin and a one-time code;
 * - `internal` routes are for the eve agent process: the per-boot secret, and no Origin at all, so no web
 *   page can reach them;
 * - Avi Studio pages are reached by a one-time token and then a view key, never the API token;
 * - every route has a rate limit; bodies have a size cap; a request id makes a repeated request get the
 *   first answer instead of running twice.
 */

export type RouteAuth = 'api' | 'pair' | 'internal' | 'studio-page' | 'studio-session' | 'view';

export interface RouteContext {
  req: IncomingMessage;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  // Aborted when the caller goes away
  signal: AbortSignal;
  log: Logger;
}

export type RouteResult =
  | { kind: 'json'; status?: number; body: unknown }
  | { kind: 'stream'; contentType: string; lines: AsyncIterable<string> }
  | { kind: 'raw'; status?: number; headers: Record<string, string>; body: string | Buffer };

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  // Names the route in logs (paths may hold view keys)
  name: string;
  auth: RouteAuth;
  rate: RateGroup;
  maxBodyBytes?: number;
  // The body's requestId makes a repeat return the first answer
  dedupe?: boolean;
  handler: (context: RouteContext) => Promise<RouteResult>;
}

export interface ServerOptions {
  host: string;
  port: number;
  pairing: PairingStore;
  internalSecretHash: string;
  log: Logger;
  limiter?: RateLimiter;
  now?: () => number;
}

interface CompiledRoute extends Route {
  pattern: RegExp;
  keys: string[];
}

const DEFAULT_BODY_BYTES = 256_000;
const DEDUPE_TTL_MS = 10 * 60_000;

function compile(route: Route): CompiledRoute {
  const keys: string[] = [];
  const source = route.path
    .split('/')
    .map(part => {
      if (part === '*') {
        keys.push('rest');
        return '(.+)';
      }
      if (part.startsWith(':')) {
        keys.push(part.slice(1));
        return '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { ...route, pattern: new RegExp(`^${source}$`), keys };
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) fail('invalid', `The request is larger than ${Math.round(limit / 1000)} KB.`);
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  const type = req.headers['content-type'] ?? '';
  if (!type.includes('application/json')) fail('invalid', 'The request must be JSON.');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('invalid', 'The request is not valid JSON.');
  }
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  return origin === COMPANION_EXTENSION_ORIGIN
    ? { 'Access-Control-Allow-Origin': COMPANION_EXTENSION_ORIGIN, Vary: 'Origin' }
    : {};
}

export class BrainServer {
  private readonly routes: CompiledRoute[] = [];
  private readonly limiter: RateLimiter;
  private readonly now: () => number;
  private readonly dedupe = new Map<string, { at: number; result: Promise<RouteResult> }>();
  private server: Server | null = null;

  constructor(private readonly options: ServerOptions) {
    this.limiter = options.limiter ?? new RateLimiter();
    this.now = options.now ?? Date.now;
  }

  add(...routes: Route[]): this {
    for (const route of routes) this.routes.push(compile(route));
    return this;
  }

  get selfOrigin(): string {
    return `http://${this.options.host}:${this.options.port}`;
  }

  async listen(): Promise<number> {
    this.server = createServer((req, res) => void this.handle(req, res));
    // Slow clients cannot hold sockets for ever; streams send their own keep-alive lines
    this.server.headersTimeout = 15_000;
    this.server.requestTimeout = 0;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      // Explicitly the loopback address: never all interfaces
      this.server!.listen(this.options.port, this.options.host, () => resolve());
    });
    const address = this.server.address();
    if (address && typeof address === 'object') this.options.port = address.port;
    return this.options.port;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  /** One request: Host, CORS preflight, route, rate limit, auth, body, then the handler. */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = this.now();
    const origin = req.headers.origin;
    let routeName = 'unmatched';
    res.once('finish', () =>
      this.options.log.info('request', {
        method: req.method,
        route: routeName,
        status: res.statusCode,
        ms: this.now() - started,
      }),
    );
    const respond = (status: number, body: unknown, extra: Record<string, string> = {}): void => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...corsHeaders(origin),
        ...extra,
      });
      res.end(JSON.stringify(body));
    };
    const respondError = (error: unknown) => {
      const { status, body } = errorReply(error);
      respond(
        status,
        body,
        body.error.retryAfterMs ? { 'Retry-After': String(Math.ceil(body.error.retryAfterMs / 1000)) } : {},
      );
    };

    try {
      const host = (req.headers.host ?? '').toLowerCase();
      if (host !== `${this.options.host}:${this.options.port}` && host !== `localhost:${this.options.port}`) {
        fail('forbidden', 'Wrong host.');
      }
      const url = new URL(req.url ?? '/', this.selfOrigin);

      // Preflight: answered only for the extension, only for the API
      if (req.method === 'OPTIONS') {
        if (origin !== COMPANION_EXTENSION_ORIGIN || !url.pathname.startsWith('/v1/'))
          fail('forbidden', 'Not allowed.');
        res.writeHead(204, {
          ...corsHeaders(origin),
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
          'Access-Control-Allow-Headers': 'authorization, content-type',
          'Access-Control-Allow-Private-Network': 'true',
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }

      let match: { route: CompiledRoute; params: Record<string, string> } | null = null;
      for (const route of this.routes) {
        if (route.method !== req.method) continue;
        const found = route.pattern.exec(url.pathname);
        if (!found) continue;
        const params: Record<string, string> = {};
        route.keys.forEach((key, index) => {
          params[key] = decodeURIComponent(found[index + 1]);
        });
        match = { route, params };
        break;
      }
      if (!match) fail('not_found', 'There is nothing here.');
      const { route, params } = match;
      routeName = route.name;

      const allowed = this.limiter.take(route.rate);
      if (!allowed.ok) fail('rate_limit', 'Too many requests; wait a moment.', { retryAfterMs: allowed.retryAfterMs });

      await this.authorize(route, req, origin);

      const body = req.method === 'GET' ? {} : await readBody(req, route.maxBodyBytes ?? DEFAULT_BODY_BYTES);
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      const context: RouteContext = {
        req,
        params,
        query: url.searchParams,
        body,
        signal: controller.signal,
        log: this.options.log.child({ route: route.name }),
      };

      const result = await this.run(route, context);
      if (result.kind === 'json') {
        respond(result.status ?? 200, result.body);
      } else if (result.kind === 'raw') {
        res.writeHead(result.status ?? 200, result.headers);
        res.end(result.body);
      } else {
        res.writeHead(200, {
          'Content-Type': result.contentType,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          ...corsHeaders(origin),
        });
        try {
          for await (const line of result.lines) {
            if (controller.signal.aborted) break;
            res.write(line.endsWith('\n') ? line : `${line}\n`);
          }
        } catch (error) {
          // A stream that breaks after it started ends with an error line the client can read
          res.write(`${JSON.stringify(errorReply(error).body)}\n`);
        }
        res.end();
      }
    } catch (error) {
      respondError(error);
    }
  }

  private async authorize(route: Route, req: IncomingMessage, origin: string | undefined): Promise<void> {
    switch (route.auth) {
      case 'api':
        if (origin !== COMPANION_EXTENSION_ORIGIN) fail('forbidden', 'Only Avi Copilot may use Avi Brain.');
        if (!(await this.options.pairing.verify(bearerToken(req.headers.authorization)))) {
          fail('auth', 'Avi Brain does not know this browser. Pair again in Avi Copilot settings.');
        }
        return;
      case 'pair':
        if (origin !== COMPANION_EXTENSION_ORIGIN) fail('forbidden', 'Only Avi Copilot may pair with Avi Brain.');
        return;
      case 'internal': {
        // Web pages always send an Origin on these requests; the eve process never does
        if (origin !== undefined) fail('forbidden', 'Not allowed.');
        const token = bearerToken(req.headers.authorization);
        if (!token || !sameSecret(token, this.options.internalSecretHash)) fail('auth', 'Not allowed.');
        return;
      }
      case 'studio-session':
        // The Studio page itself, nobody else
        if (origin !== this.selfOrigin) fail('forbidden', 'Not allowed.');
        return;
      case 'studio-page':
      case 'view':
        // Checked by the handler: a one-time token, then a view key
        return;
    }
  }

  private run(route: Route, context: RouteContext): Promise<RouteResult> {
    const requestId = (context.body as { requestId?: unknown } | null)?.requestId;
    if (!route.dedupe || typeof requestId !== 'string') return route.handler(context);
    const now = this.now();
    for (const [key, entry] of this.dedupe) if (now - entry.at > DEDUPE_TTL_MS) this.dedupe.delete(key);
    const key = `${route.name}:${requestId}`;
    const seen = this.dedupe.get(key);
    if (seen) return seen.result;
    const result = route.handler(context);
    this.dedupe.set(key, { at: now, result });
    // A failure is not kept: the same request may be tried again
    result.catch(() => this.dedupe.delete(key));
    return result;
  }
}

export function json(body: unknown, status = 200): RouteResult {
  return { kind: 'json', status, body };
}

export { AppError };
