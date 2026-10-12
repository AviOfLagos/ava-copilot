import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Dexie } from 'dexie';
import { isMaskedKey, maskKey, SecretVault, visibleTail } from '../vault';

const KEY = 'sk-test-0123456789abcdef';

function freshName() {
  return `secrets-${crypto.randomUUID()}`;
}

/** Reads the raw records, as anything with access to the database would see them. */
async function rawRecords(name: string) {
  const db = new Dexie(name);
  db.version(1).stores({ keys: 'id', secrets: 'ref' });
  const records = { keys: await db.table('keys').toArray(), secrets: await db.table('secrets').toArray() };
  db.close();
  return records;
}

describe('SecretVault', () => {
  it('stores, reads, reports and deletes a secret', async () => {
    const vault = new SecretVault(freshName(), () => true);
    expect(await vault.get('llm:openai')).toBeNull();
    expect(await vault.has('llm:openai')).toBe(false);

    await vault.put('llm:openai', `  ${KEY}  `);
    expect(await vault.get('llm:openai')).toBe(KEY);
    expect(await vault.has('llm:openai')).toBe(true);
    expect(await vault.last4('llm:openai')).toBe('cdef');
    expect(await vault.refs()).toEqual(['llm:openai']);

    await vault.put('llm:openai', 'sk-replaced-key-99999999');
    expect(await vault.get('llm:openai')).toBe('sk-replaced-key-99999999');

    await vault.delete('llm:openai');
    expect(await vault.get('llm:openai')).toBeNull();
    expect(await vault.last4('llm:openai')).toBeNull();
  });

  it('keeps no plaintext at rest, and its key cannot be exported', async () => {
    const name = freshName();
    const vault = new SecretVault(name, () => true);
    await vault.put('llm:gemini', KEY);
    const { keys, secrets } = await rawRecords(name);

    expect(keys).toHaveLength(1);
    expect(keys[0].key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', keys[0].key)).rejects.toThrow();

    const stored = new TextDecoder().decode(new Uint8Array(secrets[0].data));
    expect(stored).not.toContain(KEY);
    expect(JSON.stringify(secrets[0])).not.toContain(KEY);
    expect(secrets[0].iv).toHaveLength(12);
  });

  it('makes one key per database, shared by every context that opens it', async () => {
    const name = freshName();
    const [first, second] = [new SecretVault(name, () => true), new SecretVault(name, () => true)];
    // Both start at once: one key wins and both use it
    await Promise.all([first.put('a', 'value-a-1234567890'), second.put('b', 'value-b-1234567890')]);
    expect((await rawRecords(name)).keys).toHaveLength(1);
    expect(await second.get('a')).toBe('value-a-1234567890');
    expect(await first.get('b')).toBe('value-b-1234567890');
  });

  it('binds a secret to its name: one moved to another name does not decrypt', async () => {
    const name = freshName();
    const vault = new SecretVault(name, () => true);
    await vault.put('llm:openai', KEY);
    const db = new Dexie(name);
    db.version(1).stores({ keys: 'id', secrets: 'ref' });
    const record = await db.table('secrets').get('llm:openai');
    await db.table('secrets').put({ ...record, ref: 'llm:other' });
    db.close();
    await expect(vault.get('llm:other')).rejects.toThrow();
  });

  it('refuses to read or write outside the background, but anyone may delete or ask what exists', async () => {
    const name = freshName();
    await new SecretVault(name, () => true).put('llm:openai', KEY);
    const page = new SecretVault(name, () => false);
    await expect(page.get('llm:openai')).rejects.toThrow(/background/);
    await expect(page.put('llm:x', KEY)).rejects.toThrow(/background/);
    expect(await page.has('llm:openai')).toBe(true);
    expect(await page.last4('llm:openai')).toBe('cdef');
    await page.delete('llm:openai');
    expect(await page.has('llm:openai')).toBe(false);
  });

  it('refuses an empty secret', async () => {
    const vault = new SecretVault(freshName(), () => true);
    await expect(vault.put('llm:openai', '   ')).rejects.toThrow();
  });
});

describe('masking', () => {
  it('shows at most the last four characters, and none of a short secret', () => {
    expect(visibleTail(KEY)).toBe('cdef');
    expect(visibleTail('short-key')).toBe('');
    expect(maskKey('cdef')).toBe('••••cdef');
    expect(maskKey(undefined)).toBe('••••');
    expect(isMaskedKey('••••cdef')).toBe(true);
    expect(isMaskedKey(KEY)).toBe(false);
  });
});
