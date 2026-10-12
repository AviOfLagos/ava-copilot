import { Dexie } from 'dexie';
import type { Table } from 'dexie';

/**
 * The secrets vault: API keys and tokens, encrypted with AES-GCM under one key that WebCrypto made
 * non-extractable, kept in their own IndexedDB database. Only the background decrypts; pages see a
 * key's last characters at most.
 *
 * Honest scope: this takes keys out of `chrome.storage.local` (which content scripts can read) and off
 * disk as plaintext. It does not stop code already running in an extension page, which shares the
 * origin and could ask WebCrypto to decrypt.
 */

// Not "avi-vault": the Obsidian folder handle lives there
export const SECRETS_DB_NAME = 'avi-secrets';
const MASTER_KEY_ID = 'master';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface KeyRecord {
  id: string;
  key: CryptoKey;
  createdAt: number;
}

interface SecretRecord {
  ref: string;
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
  // Shown as ••••last4; empty when the secret is too short to show any of it safely
  last4: string;
  updatedAt: number;
}

class SecretsDb extends Dexie {
  keys!: Table<KeyRecord, string>;
  secrets!: Table<SecretRecord, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({ keys: 'id', secrets: 'ref' });
  }
}

/** The background service worker has no window; extension pages, the offscreen document and content scripts do. */
export function isBackgroundContext(): boolean {
  return typeof window === 'undefined';
}

/** What a page may see of a key: its last four characters, and none of a short one. */
export function visibleTail(secret: string): string {
  const trimmed = secret.trim();
  return trimmed.length >= 12 ? trimmed.slice(-4) : '';
}

export const KEY_MASK = '••••';

/** A key as the user sees it: ••••abcd. */
export function maskKey(last4: string | undefined | null): string {
  return `${KEY_MASK}${last4 ?? ''}`;
}

export function isMaskedKey(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(KEY_MASK);
}

export class SecretVault {
  private readonly db: SecretsDb;
  private masterKey: Promise<CryptoKey> | null = null;

  constructor(
    name = SECRETS_DB_NAME,
    // Whether this context may decrypt; replaceable in tests
    private readonly mayDecrypt: () => boolean = isBackgroundContext,
  ) {
    this.db = new SecretsDb(name);
  }

  /** Stores a secret under `ref`, then reads it back to prove it decrypts before anyone relies on it. */
  async put(ref: string, value: string): Promise<void> {
    this.assertBackground();
    const secret = value.trim();
    if (!ref || !secret) throw new Error('A secret needs a name and a value.');
    const key = await this.key();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    // The name is authenticated with the value, so a stored secret cannot be moved to another name
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(ref) },
      key,
      encoder.encode(secret),
    );
    await this.db.secrets.put({ ref, iv, data, last4: visibleTail(secret), updatedAt: Date.now() });
    if ((await this.get(ref)) !== secret) {
      await this.db.secrets.delete(ref);
      throw new Error('The secret could not be read back after saving.');
    }
  }

  /** The secret, or null when none is stored under `ref`. */
  async get(ref: string): Promise<string | null> {
    this.assertBackground();
    const record = await this.db.secrets.get(ref);
    if (!record) return null;
    const key = await this.key();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: encoder.encode(ref) },
      key,
      record.data,
    );
    return decoder.decode(plain);
  }

  /** Deleting reveals nothing, so any extension context may do it. */
  async delete(ref: string): Promise<void> {
    await this.db.secrets.delete(ref);
  }

  async has(ref: string): Promise<boolean> {
    return (await this.db.secrets.where('ref').equals(ref).count()) > 0;
  }

  /** The last characters of the secret, for display; null when none is stored. */
  async last4(ref: string): Promise<string | null> {
    return (await this.db.secrets.get(ref))?.last4 ?? null;
  }

  /** The names of the stored secrets, never their values. */
  async refs(): Promise<string[]> {
    return (await this.db.secrets.toCollection().primaryKeys()) as string[];
  }

  private assertBackground(): void {
    if (!this.mayDecrypt()) throw new Error('Only the background reads and writes keys.');
  }

  /** The vault's key: made once, never extractable, shared by every context of the extension. */
  private key(): Promise<CryptoKey> {
    if (!this.masterKey) {
      this.masterKey = this.loadOrCreateKey().catch(error => {
        this.masterKey = null;
        throw error;
      });
    }
    return this.masterKey;
  }

  private async loadOrCreateKey(): Promise<CryptoKey> {
    const existing = await this.db.keys.get(MASTER_KEY_ID);
    if (existing) return existing.key;
    const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    try {
      // add, not put: if another context made a key first, its key wins and this one is dropped
      await this.db.keys.add({ id: MASTER_KEY_ID, key: candidate, createdAt: Date.now() });
      return candidate;
    } catch (error) {
      const winner = await this.db.keys.get(MASTER_KEY_ID);
      if (winner) return winner.key;
      throw error;
    }
  }
}

export const secretVault = new SecretVault();

export const putSecret = (ref: string, value: string) => secretVault.put(ref, value);
export const getSecret = (ref: string) => secretVault.get(ref);
export const deleteSecret = (ref: string) => secretVault.delete(ref);
export const hasSecret = (ref: string) => secretVault.has(ref);
export const last4 = (ref: string) => secretVault.last4(ref);
