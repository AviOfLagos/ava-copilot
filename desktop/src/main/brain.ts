import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  COMPANION_DEFAULT_PORT,
  COMPANION_HOST,
  DESKTOP_ROUTES,
  DESKTOP_TOKEN_FILE,
  desktopReplySchema,
  desktopStatusSchema,
} from '@protocol';
import type { DesktopReply, DesktopStatus } from '@protocol';
import { z } from 'zod';

/**
 * The app's line to Ava Brain on this Mac (docs/desktop-app.md): the desktop token from Ava Brain's data folder,
 * sent with no Origin. Only the main process holds it; the window asks through IPC. Ava Brain writes a new token
 * at every start, so a refused call reads the file again once.
 */

export interface BrainLocation {
  base: string;
  tokenPath: string;
}

/** Where Ava Brain listens and keeps its token: the same variables as Ava Brain's own config. */
export function brainLocation(env: NodeJS.ProcessEnv = process.env, home = homedir()): BrainLocation {
  const port = Number(env.AVI_BRAIN_PORT ?? COMPANION_DEFAULT_PORT);
  const dataDir = env.AVI_BRAIN_HOME ?? join(home, 'Library', 'Application Support', 'Avi Brain');
  return {
    base: `http://${COMPANION_HOST}:${Number.isInteger(port) ? port : COMPANION_DEFAULT_PORT}`,
    tokenPath: join(dataDir, DESKTOP_TOKEN_FILE),
  };
}

export class BrainError extends Error {
  constructor(
    readonly kind: 'off' | 'auth' | 'refused',
    message: string,
  ) {
    super(message);
  }
}

const sendReplySchema = z.object({ ok: z.literal(true), id: z.string(), browserOpen: z.boolean() });
const messagesReplySchema = z.object({
  ok: z.literal(true),
  replies: z.array(desktopReplySchema),
  browserOpen: z.boolean(),
});

export interface BrainClientDeps {
  location: BrainLocation;
  fetch?: typeof fetch;
  readToken?: (path: string) => Promise<string>;
  newRequestId?: () => string;
}

export class BrainClient {
  private token: string | null = null;
  private readonly fetch: typeof fetch;
  private readonly readToken: (path: string) => Promise<string>;
  private readonly newRequestId: () => string;

  constructor(private readonly deps: BrainClientDeps) {
    this.fetch = deps.fetch ?? fetch;
    this.readToken = deps.readToken ?? (async path => (await readFile(path, 'utf8')).trim());
    this.newRequestId = deps.newRequestId ?? (() => crypto.randomUUID());
  }

  status(): Promise<DesktopStatus> {
    return this.call(DESKTOP_ROUTES.status, {}, desktopStatusSchema);
  }

  send(chatId: string, text: string) {
    return this.call(DESKTOP_ROUTES.send, { requestId: this.newRequestId(), chatId, text }, sendReplySchema);
  }

  async replies(after: number): Promise<{ replies: DesktopReply[]; browserOpen: boolean }> {
    return this.call(DESKTOP_ROUTES.messages, { after }, messagesReplySchema);
  }

  private async call<S extends z.ZodType>(path: string, body: unknown, schema: S, again = true): Promise<z.infer<S>> {
    if (!this.token) {
      try {
        this.token = await this.readToken(this.deps.location.tokenPath);
      } catch {
        throw new BrainError('off', 'Ava Brain is not running on this Mac.');
      }
    }
    let response: Response;
    try {
      response = await this.fetch(`${this.deps.location.base}${path}`, {
        method: 'POST',
        // No Origin: Node's fetch sends none, and Ava Brain refuses one on these routes
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new BrainError('off', 'Ava Brain is not running on this Mac.');
    }
    if (response.status === 401 && again) {
      // Ava Brain started again since: its token is new
      this.token = null;
      return this.call(path, body, schema, false);
    }
    if (response.status === 404) throw new BrainError('refused', 'This Ava Brain is older than the app. Update it.');
    if (!response.ok) {
      const reply = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new BrainError(
        response.status === 401 ? 'auth' : 'refused',
        reply?.error?.message ?? `Ava Brain said ${response.status}.`,
      );
    }
    return schema.parse(await response.json());
  }
}
