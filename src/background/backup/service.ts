import { AppError, toAppError } from '@extension/shared';
import { BACKUP_CHUNK_BYTES, backupSecretRefSchema } from '@src/shared/lib/protocol/companion';
import type { BackupListReply, BackupMeta } from '@src/shared/lib/protocol/companion';
import type { CompanionClient } from '../companion/client';
import { fromBase64, sha256Hex, toBase64 } from './codec';
import { PROTECTED_SECRET_REFS, restoreSnapshot } from './restore';
import type { RestoreSummary, RestoreTarget, SecretsTarget } from './restore';
import { buildSnapshot, parseSnapshot } from './snapshot';
import type { SnapshotSource } from './snapshot';
import type { BackupSettings, BackupStatus } from './state';

/**
 * Backs this browser up to Nex Brain and restores it from there: the snapshot in 4 MB parts, checked by its
 * SHA-256 at both ends, and the API keys apart from it (into the Mac's Keychain) when the user keeps that on.
 * Only the background runs this: it alone may read the vault.
 */

export type BackupClient = Pick<
  CompanionClient,
  | 'backupBegin'
  | 'backupChunk'
  | 'backupCommit'
  | 'backupList'
  | 'backupRead'
  | 'backupSecretsPut'
  | 'backupSecretsGet'
  | 'backupSecretsClear'
>;

export interface BackupDeps {
  client: BackupClient;
  source: SnapshotSource;
  target: RestoreTarget;
  // Read access to the vault; writing goes through target.secrets
  vault: SecretsTarget & { get(ref: string): Promise<string | null> };
  paired: () => Promise<boolean>;
  settings: () => Promise<BackupSettings>;
  status: { get: () => Promise<BackupStatus>; update: (changes: Partial<BackupStatus>) => Promise<unknown> };
  now?: () => number;
}

export const NOT_PAIRED_MESSAGE = 'Pair Nex Brain first (Settings › Connections › Nex Brain).';

/** The vault's keys and sign-ins that a backup keeps: all but the pairing token, and only names it can carry. */
export async function collectSecrets(
  vault: BackupDeps['vault'],
): Promise<{ secrets: Record<string, string>; skipped: number }> {
  const secrets: Record<string, string> = {};
  let skipped = 0;
  for (const ref of await vault.refs()) {
    if (PROTECTED_SECRET_REFS.has(ref)) continue;
    if (!backupSecretRefSchema.safeParse(ref).success) {
      skipped += 1;
      continue;
    }
    const value = await vault.get(ref).catch(() => null);
    if (value && value.length <= 20_000) secrets[ref] = value;
    else skipped += 1;
  }
  return { secrets, skipped };
}

export class BackupService {
  private running: Promise<BackupMeta | null> | null = null;

  constructor(private readonly deps: BackupDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** One backup at a time: a second call while one runs gets the same result. */
  backupNow(manual: boolean): Promise<BackupMeta | null> {
    this.running ??= this.run(manual).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(manual: boolean): Promise<BackupMeta | null> {
    if (!(await this.deps.paired())) {
      if (manual) throw new AppError('auth', NOT_PAIRED_MESSAGE, { retryable: false });
      return null;
    }
    await this.deps.status.update({ running: true });
    try {
      const built = await buildSnapshot(this.deps.source);
      const sha256 = await sha256Hex(built.bytes);
      const begin = await this.deps.client.backupBegin({
        requestId: `backup-${built.createdAt}-${sha256.slice(0, 16)}`,
        createdAt: built.createdAt,
        bytes: built.bytes.length,
        sha256,
        dbVersion: built.dbVersion,
        extensionVersion: this.deps.source.extensionVersion.slice(0, 40),
        counts: built.counts,
      });
      const size = Math.min(begin.chunkBytes, BACKUP_CHUNK_BYTES);
      for (let index = 0; index * size < built.bytes.length; index++) {
        const part = built.bytes.subarray(index * size, (index + 1) * size);
        await this.deps.client.backupChunk(begin.uploadId, index, toBase64(part));
      }
      const { snapshot } = await this.deps.client.backupCommit(begin.uploadId);

      // The keys follow the snapshot; with the setting off, the copy on the Mac is removed
      let kept: number | null = null;
      if ((await this.deps.settings()).includeSecrets) {
        const { secrets } = await collectSecrets(this.deps.vault);
        if (Object.keys(secrets).length) {
          kept = (await this.deps.client.backupSecretsPut(`backup-keys-${snapshot.id}`, secrets)).count;
        } else {
          await this.deps.client.backupSecretsClear();
          kept = 0;
        }
      } else {
        await this.deps.client.backupSecretsClear();
      }

      await this.deps.status.update({
        running: false,
        lastBackupAt: snapshot.createdAt,
        lastSnapshotId: snapshot.id,
        lastBytes: snapshot.bytes,
        lastSecrets: kept,
        lastError: null,
        lastErrorAt: null,
      });
      return snapshot;
    } catch (error) {
      const appError = toAppError(error);
      await this.deps.status.update({ running: false, lastError: appError.message, lastErrorAt: this.now() });
      if (manual) throw appError;
      return null;
    }
  }

  async list(): Promise<BackupListReply> {
    if (!(await this.deps.paired())) throw new AppError('auth', NOT_PAIRED_MESSAGE, { retryable: false });
    return this.deps.client.backupList();
  }

  /** Downloads a snapshot, checks it, and replaces this browser's data with it (and the keys, when kept). */
  async restoreFromBrain(id: string): Promise<RestoreSummary> {
    const { snapshots } = await this.list();
    const meta = snapshots.find(snapshot => snapshot.id === id);
    if (!meta) throw new AppError('not_found', 'That backup is not on the Mac any more.', { retryable: false });
    const bytes = new Uint8Array(meta.bytes);
    let offset = 0;
    for (let index = 0, chunks = 1; index < chunks; index++) {
      const reply = await this.deps.client.backupRead(id, index);
      chunks = reply.chunks;
      const part = fromBase64(reply.data);
      if (offset + part.length > bytes.length) throw new AppError('invalid', 'The backup came back larger than it is.');
      bytes.set(part, offset);
      offset += part.length;
    }
    if (offset !== bytes.length || (await sha256Hex(bytes)) !== meta.sha256) {
      throw new AppError('invalid', 'The backup came back damaged. Try again.');
    }
    const snapshot = await parseSnapshot(bytes);

    let secrets: Record<string, string> | null = null;
    if ((await this.deps.settings()).includeSecrets) {
      // Keys that cannot be read (the Keychain entry is gone) do not stop the restore: they are typed again
      secrets = await this.deps.client
        .backupSecretsGet()
        .then(reply => (Object.keys(reply.secrets).length ? reply.secrets : null))
        .catch(() => null);
    }
    return restoreSnapshot(snapshot, this.deps.target, secrets);
  }

  /**
   * A snapshot file from disk: the same checks, never any keys, and treated as untrusted (anyone could have made
   * it): security settings stay as they are here, and keys are unbound from endpoints that changed.
   */
  async restoreFromFile(bytes: Uint8Array<ArrayBuffer>): Promise<RestoreSummary> {
    return restoreSnapshot(await parseSnapshot(bytes), this.deps.target, null, { untrusted: true });
  }
}
