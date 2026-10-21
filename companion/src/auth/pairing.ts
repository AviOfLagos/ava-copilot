import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizePairingCode, PAIRING_ALPHABET } from '@protocol';
import { privateDir } from '../config';
import { AppError } from '../errors';

/**
 * Pairing: `nex-brain pair` prints a one-time code (8 characters, 10 minutes, 5 tries); the extension
 * trades it once for a long-lived token, which it keeps in its vault. The Mac keeps only the token's
 * hash. Pairing again replaces the token, so a lost browser profile is cut off by pairing anew.
 *
 * The code and the token live in two files only this user can read; the server reads them on each
 * request, so `nex-brain pair` in a terminal and the running server never need to talk to each other.
 */

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;

interface PendingCode {
  hash: string;
  expiresAt: number;
  attempts: number;
}

interface AuthFile {
  tokenHash: string;
  client: string;
  pairedAt: number;
  companionId: string;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Equal strings, in time that does not depend on where they differ (both are hashed first). */
export function sameSecret(given: string, expectedHash: string): boolean {
  const a = Buffer.from(sha256(given), 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newPairingCode(): string {
  const chars = Array.from({ length: 8 }, () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export class PairingStore {
  private readonly codePath: string;
  private readonly authPath: string;
  // Changes run one at a time, so two tries at once cannot both spend the same code
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    privateDir(dataDir);
    this.codePath = join(dataDir, 'pairing.json');
    this.authPath = join(dataDir, 'auth.json');
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  /** A fresh one-time code; any earlier code stops working. */
  createCode(): Promise<string> {
    return this.serial(async () => {
      const code = newPairingCode();
      await writePrivate(this.codePath, { hash: sha256(code), expiresAt: this.now() + CODE_TTL_MS, attempts: 0 });
      return code;
    });
  }

  /** Trades a one-time code for a token. A wrong, used or expired code is refused; too many tries burn it. */
  redeem(input: string, client: string): Promise<{ token: string; companionId: string }> {
    return this.serial(() => this.redeemNow(input, client));
  }

  private async redeemNow(input: string, client: string): Promise<{ token: string; companionId: string }> {
    const pending = await readJson<PendingCode>(this.codePath);
    if (!pending || pending.expiresAt < this.now()) {
      if (pending) await rm(this.codePath, { force: true });
      throw new AppError('forbidden', 'No pairing code is waiting. Run `nex-brain pair` on your Mac for a new one.');
    }
    const code = normalizePairingCode(input);
    if (!code || !sameSecret(code, pending.hash)) {
      const attempts = pending.attempts + 1;
      if (attempts >= MAX_CODE_ATTEMPTS) await rm(this.codePath, { force: true });
      else await writePrivate(this.codePath, { ...pending, attempts });
      throw new AppError(
        'forbidden',
        attempts >= MAX_CODE_ATTEMPTS
          ? 'That code is no longer valid after too many tries. Run `nex-brain pair` for a new one.'
          : 'That code is not right. Check it and try again.',
      );
    }
    await rm(this.codePath, { force: true });
    return this.issueToken(client);
  }

  /**
   * A token with no code, for Nex Copilot's own extension origin (the route checks it). Like a code, it replaces the
   * browser paired before; any code still waiting stops working.
   */
  autoPair(client: string): Promise<{ token: string; companionId: string }> {
    return this.serial(async () => {
      await rm(this.codePath, { force: true });
      return this.issueToken(client);
    });
  }

  private async issueToken(client: string): Promise<{ token: string; companionId: string }> {
    const token = randomBytes(32).toString('base64url');
    const existing = await readJson<AuthFile>(this.authPath);
    const companionId = existing?.companionId ?? randomBytes(8).toString('hex');
    await writePrivate(this.authPath, {
      tokenHash: sha256(token),
      client: client.slice(0, 80),
      pairedAt: this.now(),
      companionId,
    } satisfies AuthFile);
    return { token, companionId };
  }

  /** Whether a bearer token is the paired one. Fails closed: no file, a bad file or no token is false. */
  async verify(token: string | null): Promise<boolean> {
    if (!token) return false;
    try {
      const auth = await readJson<AuthFile>(this.authPath);
      return Boolean(auth?.tokenHash) && sameSecret(token, auth!.tokenHash);
    } catch {
      return false;
    }
  }

  revoke(): Promise<void> {
    return this.serial(async () => {
      const existing = await readJson<AuthFile>(this.authPath).catch(() => null);
      // The id stays, so the extension recognises this Mac when it pairs again
      if (existing) {
        await writePrivate(this.authPath, {
          tokenHash: '',
          client: '',
          pairedAt: 0,
          companionId: existing.companionId,
        });
      }
    });
  }

  async status(): Promise<{ paired: boolean; client: string | null; pairedAt: number | null; companionId: string }> {
    let auth = await readJson<AuthFile>(this.authPath).catch(() => null);
    if (!auth?.companionId) {
      auth = { tokenHash: '', client: '', pairedAt: 0, companionId: randomBytes(8).toString('hex') };
      await writePrivate(this.authPath, auth);
    }
    return {
      paired: Boolean(auth.tokenHash),
      client: auth.client || null,
      pairedAt: auth.pairedAt || null,
      companionId: auth.companionId,
    };
  }
}

/** The token from an Authorization header, or null. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{16,512})$/.exec(header.trim());
  return match ? match[1] : null;
}
