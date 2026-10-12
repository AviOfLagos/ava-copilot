import { platform } from 'node:os';
import { fail } from '../errors';
import { hostToolEnv } from '../sandbox/process';
import type { ProcessRunner } from '../sandbox/process';

/**
 * Model keys on the Mac. By default a key lives in the companion's memory only, for as long as it runs
 * (the extension sends it again when it connects). A routine that must run with Brave closed after a
 * restart can keep its key in the macOS Keychain. The key goes to `security` on its standard input
 * (`security -i`), never on a command line, where other processes could read it.
 */

const SERVICE = 'Avi Brain';

export interface KeyStore {
  set(ref: string, key: string, persist: boolean): Promise<void>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
}

// What a key may contain: printable characters without spaces or quotes, so it can be quoted safely
const KEY_PATTERN = /^[\x21\x23-\x26\x28-\x5b\x5d-\x7e]{1,500}$/;
const REF_PATTERN = /^[A-Za-z0-9:_-]{1,120}$/;

export function createKeyStore(deps: { run: ProcessRunner; isMac?: boolean }): KeyStore {
  const memory = new Map<string, string>();
  const isMac = deps.isMac ?? platform() === 'darwin';
  const security = (stdin: string, args: string[] = ['-i']) =>
    deps.run('/usr/bin/security', args, { env: hostToolEnv(), timeoutMs: 10_000, stdin, maxOutputBytes: 10_000 });

  return {
    async set(ref, key, persist) {
      if (!REF_PATTERN.test(ref)) fail('invalid', 'That key name is not allowed.');
      if (!KEY_PATTERN.test(key)) fail('invalid', 'That key has characters a key does not have.');
      memory.set(ref, key);
      if (!persist) return;
      if (!isMac) fail('invalid', 'Keeping a key is only possible on macOS (in the Keychain).');
      const result = await security(`add-generic-password -U -a "${ref}" -s "${SERVICE}" -w "${key}"\n`);
      if (result.code !== 0) fail('unavailable', 'The Keychain did not accept the key.');
    },
    async get(ref) {
      if (!REF_PATTERN.test(ref)) return null;
      const known = memory.get(ref);
      if (known) return known;
      if (!isMac) return null;
      const result = await security('', ['find-generic-password', '-a', ref, '-s', SERVICE, '-w']);
      if (result.code !== 0) return null;
      const key = result.stdout.trim();
      if (!key) return null;
      memory.set(ref, key);
      return key;
    },
    async delete(ref) {
      memory.delete(ref);
      if (!isMac || !REF_PATTERN.test(ref)) return;
      await security(`delete-generic-password -a "${ref}" -s "${SERVICE}"\n`).catch(() => undefined);
    },
  };
}
