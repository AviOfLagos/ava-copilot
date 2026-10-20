/**
 * A small Chrome DevTools Protocol client: commands with replies, events, and flat sessions for page targets.
 * It runs over any transport that moves whole JSON messages; the meeting browser uses Chrome's debugging pipe
 * (no port that any other program on the Mac could reach), tests use an in-memory fake.
 */

export interface CdpTransport {
  send(message: string): void;
  // Every whole message from the browser
  onMessage(listener: (message: string) => void): void;
  // The browser went away (it exited or the pipe broke)
  onClose(listener: () => void): void;
  close(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type EventListener = (params: Record<string, unknown>, sessionId: string | undefined) => void;

export class CdpError extends Error {
  constructor(
    message: string,
    readonly method: string,
  ) {
    super(message);
    this.name = 'CdpError';
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<EventListener>>();
  private closed = false;
  private readonly closeListeners = new Set<() => void>();

  constructor(private readonly transport: CdpTransport) {
    transport.onMessage(raw => this.receive(raw));
    transport.onClose(() => this.shutDown());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Sends one command and waits for its reply; a `sessionId` sends it to that page. */
  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    options: { sessionId?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError('The meeting browser is closed.', method));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`The meeting browser did not answer ${method}.`, method));
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.transport.send(
        JSON.stringify({ id, method, params, ...(options.sessionId ? { sessionId: options.sessionId } : {}) }),
      );
    });
  }

  /** Listens to an event; returns how to stop. */
  on(method: string, listener: EventListener): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.transport.close();
    this.shutDown();
  }

  private receive(raw: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      result?: unknown;
    };
    let error: { message?: string } | undefined;
    try {
      message = JSON.parse(raw);
      error = (message as { error?: { message?: string } }).error;
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (error) pending.reject(new CdpError(error.message ?? 'The meeting browser refused a command.', ''));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === 'string') {
      for (const listener of this.listeners.get(message.method) ?? []) {
        try {
          listener(message.params ?? {}, message.sessionId);
        } catch {
          // A listener's mistake never stops the others
        }
      }
    }
  }

  private shutDown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CdpError('The meeting browser closed.', ''));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
  }
}

/**
 * The browser's page, attached as a flat session. A browser just started may not have opened its window yet,
 * so it is waited for a few seconds before one is made.
 */
export async function attachToPage(cdp: CdpConnection, waitMs = 5000, stepMs = 100): Promise<string> {
  let targetId: string | undefined;
  for (let waited = 0; ; waited += stepMs) {
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>('Target.getTargets');
    targetId = targetInfos.find(target => target.type === 'page')?.targetId;
    if (targetId || waited >= waitMs) break;
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
  targetId ??= (await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId;
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  return sessionId;
}

/** Evaluates an expression in a page and returns its value (awaiting a promise). Throws what the page threw. */
export async function evaluate<T>(
  cdp: CdpConnection,
  sessionId: string,
  expression: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const reply = await cdp.send<{
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, { sessionId, timeoutMs });
  if (reply.exceptionDetails) {
    throw new CdpError(
      reply.exceptionDetails.exception?.description?.split('\n')[0] ?? reply.exceptionDetails.text ?? 'The page threw.',
      'Runtime.evaluate',
    );
  }
  return reply.result?.value as T;
}
