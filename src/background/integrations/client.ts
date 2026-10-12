import { AppError, parseRetryAfter } from '@extension/shared';
import { connectorError } from './errors';
import type { HttpTrace } from './errors';
import { cleanListing, MAX_TOOLS } from './fingerprint';
import type { ListedTool } from './fingerprint';
import {
  CfWorkerJsonSchemaValidator,
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from './sdk';
import type { FetchLike, JsonSchemaType, jsonSchemaValidator } from './sdk';

/**
 * One short MCP session per piece of work: connect, do it, close. Nothing stays open in a service worker that
 * can stop at any time, and a server that forgot a session (it restarted, or expired it) gets a new one once.
 * Streamable HTTP is the transport; a server that refuses it the way old servers do is tried over HTTP+SSE.
 */

export type TransportKind = 'streamable_http' | 'sse';

export interface SessionOptions {
  url: string;
  // The connector's name, for error sentences
  name: string;
  transport: 'auto' | TransportKind;
  headers: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  fetch?: FetchLike;
}

export interface SessionInfo {
  transport: TransportKind;
  serverInfo: { name: string; version: string } | null;
}

const MAX_LIST_PAGES = 20;

function clientInfo() {
  return { name: 'avi-copilot', version: globalThis.chrome?.runtime?.getManifest?.().version ?? '0' };
}

/**
 * Validates tool output with @cfworker/json-schema (no code generation, so the extension's CSP allows it). An
 * output schema it cannot read checks nothing instead of breaking the whole tool list: output is untrusted data
 * either way.
 */
class SafeValidator implements jsonSchemaValidator {
  private readonly inner = new CfWorkerJsonSchemaValidator();

  getValidator<T>(schema: JsonSchemaType) {
    try {
      return this.inner.getValidator<T>(schema);
    } catch {
      return (input: unknown) => ({ valid: true as const, data: input as T, errorMessage: undefined });
    }
  }
}

/** Rejects with a timeout if `work` takes longer than `ms`, after calling `onTimeout` to cut it off. */
function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => void, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new AppError('timeout', `${name} did not answer in time.`));
    }, ms);
    work.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// How old servers (HTTP+SSE only) answer a Streamable HTTP POST
function looksLikeOldServer(error: unknown): boolean {
  return error instanceof StreamableHTTPError && [400, 404, 405].includes(error.code ?? 0);
}

interface Opened {
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport;
  kind: TransportKind;
  // Stops listening to the caller's stop signal
  detach: () => void;
}

async function closeQuietly(opened: Opened): Promise<void> {
  opened.detach();
  // A session is ended politely when the server gave one; a server that does not allow it says 405, which is fine
  if (opened.transport instanceof StreamableHTTPClientTransport && opened.transport.sessionId) {
    const ending = opened.transport.terminateSession().catch(() => {});
    await Promise.race([ending, new Promise(resolve => setTimeout(resolve, 1500))]);
  }
  await opened.client.close().catch(() => {});
}

/**
 * Opens a session, runs `work` with its client, and closes it, whatever happens.
 *
 * @throws AppError for anything that went wrong, with a sentence fit for the user and the agent
 */
export async function withMcpSession<T>(
  options: SessionOptions,
  work: (client: Client, info: SessionInfo) => Promise<T>,
): Promise<{ value: T; info: SessionInfo }> {
  const trace: HttpTrace = { status: null };
  const baseFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const tracedFetch: FetchLike = async (input, init) => {
    const response = await baseFetch(input, init);
    trace.status = response.status;
    trace.retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    return response;
  };

  const open = async (kind: TransportKind): Promise<Opened> => {
    if (options.signal?.aborted) throw new AppError('cancelled', 'Stopped.');
    const url = new URL(options.url);
    const requestInit: RequestInit = { headers: options.headers };
    const transport =
      kind === 'sse'
        ? new SSEClientTransport(url, { requestInit, fetch: tracedFetch })
        : new StreamableHTTPClientTransport(url, {
            requestInit,
            fetch: tracedFetch,
            // The session lives for one piece of work: no waiting to reconnect a dropped stream
            reconnectionOptions: {
              maxRetries: 0,
              initialReconnectionDelay: 1000,
              maxReconnectionDelay: 1000,
              reconnectionDelayGrowFactor: 1,
            },
          });
    const client = new Client(clientInfo(), { capabilities: {}, jsonSchemaValidator: new SafeValidator() });
    const abort = () => void client.close().catch(() => {});
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      // The SSE transport waits for the server's endpoint event with no limit of its own
      await withDeadline(
        client.connect(transport, { timeout: options.timeoutMs, signal: options.signal }),
        options.timeoutMs + 2000,
        abort,
        options.name,
      );
    } catch (error) {
      options.signal?.removeEventListener('abort', abort);
      await client.close().catch(() => {});
      throw error;
    }
    return { client, transport, kind, detach: () => options.signal?.removeEventListener('abort', abort) };
  };

  let opened: Opened;
  const first: TransportKind = options.transport === 'sse' ? 'sse' : 'streamable_http';
  try {
    opened = await open(first);
  } catch (error) {
    if (options.transport !== 'auto' || !looksLikeOldServer(error)) throw connectorError(error, options.name, trace);
    try {
      opened = await open('sse');
    } catch {
      // The Streamable HTTP answer says more about what is wrong than the SSE attempt's
      throw connectorError(error, options.name, trace);
    }
  }

  const infoOf = (current: Opened): SessionInfo => {
    const server = current.client.getServerVersion();
    return {
      transport: current.kind,
      serverInfo: server ? { name: String(server.name ?? ''), version: String(server.version ?? '') } : null,
    };
  };

  try {
    return { value: await work(opened.client, infoOf(opened)), info: infoOf(opened) };
  } catch (error) {
    // The server forgot the session between two requests: one new session, and the work once more. A 404 for
    // a session means the request was not handled, so even a write is safe to send again
    const hadSession = opened.transport instanceof StreamableHTTPClientTransport && Boolean(opened.transport.sessionId);
    if (hadSession && error instanceof StreamableHTTPError && error.code === 404 && !options.signal?.aborted) {
      await closeQuietly(opened);
      try {
        opened = await open(opened.kind);
        return { value: await work(opened.client, infoOf(opened)), info: infoOf(opened) };
      } catch (retryError) {
        throw connectorError(retryError, options.name, trace);
      }
    }
    if (options.signal?.aborted) throw new AppError('cancelled', 'Stopped.', { cause: error });
    throw connectorError(error, options.name, trace);
  } finally {
    await closeQuietly(opened);
  }
}

/** Every tool the server lists, page by page (at most MAX_TOOLS). */
export async function listAllTools(
  client: Client,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<ListedTool[]> {
  const tools: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await client.listTools(cursor ? { cursor } : undefined, {
      timeout: options.timeoutMs,
      signal: options.signal,
    });
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (!cursor || tools.length >= MAX_TOOLS) break;
  }
  return cleanListing(tools);
}
