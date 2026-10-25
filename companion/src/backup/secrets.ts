import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { backupSecretsSchema } from '@protocol';
import { fail } from '../errors';
import type { Logger } from '../log';
import { hostToolEnv } from '../sandbox/process';
import type { ProcessRunner } from '../sandbox/process';
import { readIfExists, writePrivateFile } from './store';

/**
 * The extension's API keys and sign-ins, kept apart from the snapshots: one file, `backups/secrets.enc`,
 * encrypted with AES-256-GCM under a random key that lives only in the macOS Keychain (service
 * "Ava Brain backup"). The file alone is useless, and the Keychain entry alone holds no key of any service.
 *
 * The Keychain key goes to `security` on its standard input (`security -i`), never on a command line, where
 * other processes could read it in `ps`. Values are never logged.
 */

export const KEYCHAIN_SERVICE = 'Nex Brain backup';
const KEYCHAIN_ACCOUNT = 'backup-key';
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;

/** Where the file key lives; a stand-in in tests, which never touch the real Keychain. */
export interface KeychainAdapter {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
}

export function securityKeychain(deps: { run: ProcessRunner; isMac?: boolean; service?: string }): KeychainAdapter {
  const isMac = deps.isMac ?? platform() === 'darwin';
  const service = deps.service ?? KEYCHAIN_SERVICE;
  const security = (args: string[], stdin = '') =>
    deps.run('/usr/bin/security', args, { env: hostToolEnv(), timeoutMs: 15_000, stdin, maxOutputBytes: 10_000 });
  const unavailable = () => fail('unavailable', 'Keeping keys needs the macOS Keychain, and this is not a Mac.');
  return {
    async get(account) {
      if (!isMac) unavailable();
      // Only names on the command line; the key comes back on standard output
      const result = await security(['find-generic-password', '-a', account, '-s', service, '-w']);
      if (result.code !== 0) return null;
      return result.stdout.trim() || null;
    },
    async set(account, value) {
      if (!isMac) unavailable();
      // Checked so it can be quoted on the interactive line safely: base64url only
      if (!KEY_TEXT.test(value) || !/^[A-Za-z0-9 _-]+$/.test(account)) fail('invalid', 'That key cannot be kept.');
      const result = await security(['-i'], `add-generic-password -U -a "${account}" -s "${service}" -w "${value}"\n`);
      if (result.code !== 0) fail('unavailable', 'The Keychain did not accept the backup key.');
    },
  };
}

const fileSchema = z.object({
  v: z.literal(1),
  storedAt: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
});

export class BackupSecrets {
  private readonly path: string;

  constructor(private readonly deps: { dir: string; keychain: KeychainAdapter; log: Logger; now?: () => number }) {
    this.path = join(deps.dir, 'secrets.enc');
  }

  private async key(create: boolean): Promise<Buffer | null> {
    const kept = await this.deps.keychain.get(KEYCHAIN_ACCOUNT);
    if (kept && KEY_TEXT.test(kept)) return Buffer.from(kept, 'base64url');
    if (!create) return null;
    const fresh = randomBytes(32);
    await this.deps.keychain.set(KEYCHAIN_ACCOUNT, fresh.toString('base64url'));
    // Read back: a key the Keychain did not keep would make the file unreadable later
    const again = await this.deps.keychain.get(KEYCHAIN_ACCOUNT);
    if (again !== fresh.toString('base64url')) fail('unavailable', 'The Keychain did not keep the backup key.');
    return fresh;
  }

  private async readFile(): Promise<z.infer<typeof fileSchema> | null> {
    const raw = await readIfExists(this.path);
    if (!raw) return null;
    const parsed = fileSchema.safeParse(JSON.parse(raw.toString('utf8')));
    return parsed.success ? parsed.data : null;
  }

  /** When the keys were last kept, and how many, without decrypting anything. */
  async state(): Promise<{ storedAt: number | null; count: number }> {
    const file = await this.readFile().catch(() => null);
    return { storedAt: file?.storedAt ?? null, count: file?.count ?? 0 };
  }

  async put(secrets: Record<string, string>): Promise<{ storedAt: number; count: number }> {
    const checked = backupSecretsSchema.parse(secrets);
    const key = (await this.key(true))!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(checked), 'utf8'), cipher.final()]);
    const storedAt = this.deps.now?.() ?? Date.now();
    const count = Object.keys(checked).length;
    await writePrivateFile(
      this.path,
      JSON.stringify({
        v: 1,
        storedAt,
        count,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      }),
    );
    this.deps.log.info('Backup keys kept', { count });
    return { storedAt, count };
  }

  /** The kept keys, or none when there is no file or its key is gone from the Keychain. */
  async get(): Promise<{ secrets: Record<string, string>; storedAt: number | null }> {
    const file = await this.readFile();
    if (!file) return { secrets: {}, storedAt: null };
    const key = await this.key(false);
    if (!key) fail('unavailable', 'The backup key is not in the Keychain any more, so the kept keys cannot be read.');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]);
      return { secrets: backupSecretsSchema.parse(JSON.parse(plain.toString('utf8'))), storedAt: file.storedAt };
    } catch {
      fail('unavailable', 'The kept keys could not be read.');
    }
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }
}
