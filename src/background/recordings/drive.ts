import { AppError } from '@extension/shared';

/**
 * Google Drive for screen recordings, over Drive's REST API with the `google_drive` connector's token and its
 * `drive.file` scope, which reaches only files Ava made (docs/pm-desk.md, Part 7).
 *
 * - Folders: "Ava recordings / <workspace>", found or made one level at a time.
 * - Upload: Drive's resumable upload. The session address is handed to the caller before any byte is sent, so a
 *   retry after a dropped connection asks Drive how far it got and carries on into the same file. Drive makes the
 *   file only when the last byte is in: a session that never finished leaves nothing behind.
 * - Sharing: one "anyone with the link can comment" permission, made and removed on the user's click only. Files
 *   start private: an upload never sets a permission.
 *
 * Nothing here logs an address, a token or a link.
 */

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const ROOT_FOLDER = 'Ava recordings';
// Every piece but the last must be a multiple of 256 KiB
export const PIECE_BYTES = 32 * 256 * 1024;
// A dropped connection is asked about and carried on from this many times in one go, then left to a later retry
const RESUMES_PER_RUN = 5;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DriveDeps {
  fetch: FetchLike;
  // A token to call with (renewed first when it is about to run out)
  token: () => Promise<string>;
  // Drive refused `used`: a fresh one
  renew: (used: string) => Promise<string>;
  api?: string;
  uploadApi?: string;
}

export interface DriveFile {
  id: string;
  name?: string;
  webViewLink?: string | null;
}

export type SessionState = { done: true; file: DriveFile } | { done: false; next: number } | { gone: true };

const quote = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** "bytes=0-1048575" → 1048576, the next byte Drive wants; no header → 0. */
export function nextByte(range: string | null): number {
  const match = range?.match(/bytes=0-(\d+)/);
  return match ? Number(match[1]) + 1 : 0;
}

async function failure(response: Response, what: string): Promise<AppError> {
  const status = response.status;
  const reason = await response
    .json()
    .then((body: { error?: { errors?: { reason?: string }[] } }) => body?.error?.errors?.[0]?.reason ?? '')
    .catch(() => '');
  if (status === 401) return new AppError('auth', 'Google Drive needs you to sign in again (Connectors).');
  if (status === 403 && /rateLimit|userRateLimit/i.test(reason)) {
    return new AppError('rate_limit', 'Google Drive asked Ava to slow down.', { retryable: true, status });
  }
  if (status === 403 && /storageQuota/i.test(reason)) {
    return new AppError('invalid', 'Your Google Drive is full.', { retryable: false, status });
  }
  if (status === 403) {
    return new AppError('forbidden', `Google Drive refused to ${what}.`, { retryable: false, status });
  }
  if (status === 404) return new AppError('not_found', `Google Drive could not find what Ava asked to ${what}.`);
  if (status === 429 || status >= 500) {
    return new AppError('unavailable', 'Google Drive is not answering right now.', { retryable: true, status });
  }
  return new AppError('invalid', `Google Drive would not ${what} (${status}).`, { retryable: false, status });
}

const isNetwork = (error: unknown) =>
  error instanceof TypeError || (error instanceof DOMException && error.name !== 'AbortError');

export class DriveRecordings {
  private readonly api: string;
  private readonly uploadApi: string;
  // Folder lookups run one at a time, so two uploads never both make "Ava recordings"
  private folders: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: DriveDeps) {
    this.api = deps.api ?? DRIVE_API;
    this.uploadApi = deps.uploadApi ?? DRIVE_UPLOAD_API;
  }

  /** A call with the token; once more with a fresh token when Drive refuses it. */
  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const send = (token: string) =>
      this.deps.fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
        credentials: 'omit',
        cache: 'no-store',
      });
    const token = await this.deps.token();
    const response = await send(token);
    if (response.status !== 401) return response;
    return send(await this.deps.renew(token));
  }

  private async json<T>(url: string, init: RequestInit, what: string): Promise<T> {
    const response = await this.call(url, init);
    if (!response.ok) throw await failure(response, what);
    return (await response.json()) as T;
  }

  private async child(name: string, parent: string): Promise<string> {
    const q = `name = ${quote(name)} and mimeType = ${quote(FOLDER_MIME)} and ${quote(parent)} in parents and trashed = false`;
    const found = await this.json<{ files?: { id: string }[] }>(
      `${this.api}/files?${new URLSearchParams({ q, fields: 'files(id)', spaces: 'drive', pageSize: '1' })}`,
      { method: 'GET' },
      'look for a folder',
    );
    if (found.files?.[0]?.id) return found.files[0].id;
    const made = await this.json<{ id: string }>(
      `${this.api}/files?fields=id`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
      },
      'make a folder',
    );
    return made.id;
  }

  /** The id of "Ava recordings / <each name>", made where missing. */
  folder(names: string[]): Promise<string> {
    const run = this.folders.then(async () => {
      let parent = 'root';
      for (const name of [ROOT_FOLDER, ...names]) parent = await this.child(name, parent);
      return parent;
    });
    this.folders = run.catch(() => undefined);
    return run;
  }

  /** Opens a resumable upload session for a new private file, and returns its address. */
  async startSession(input: { name: string; parentId: string; mimeType: string; size: number }): Promise<string> {
    const response = await this.call(`${this.uploadApi}/files?uploadType=resumable&fields=id,name,webViewLink`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': input.mimeType,
        'X-Upload-Content-Length': String(input.size),
      },
      body: JSON.stringify({ name: input.name, parents: [input.parentId], mimeType: input.mimeType }),
    });
    if (!response.ok) throw await failure(response, 'start the upload');
    const location = response.headers.get('Location');
    if (!location || !this.isSession(location)) throw new AppError('invalid', 'Google Drive did not open an upload.');
    return location;
  }

  /** A session address is Drive's own: the token goes with every request to it, so nowhere else will do. */
  isSession(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && parsed.origin === new URL(this.uploadApi).origin;
    } catch {
      return false;
    }
  }

  /** How far a session got: finished (with the file), the next byte it wants, or gone (expired, a week on). */
  async sessionStatus(sessionUrl: string, size: number): Promise<SessionState> {
    if (!this.isSession(sessionUrl)) return { gone: true };
    const response = await this.call(sessionUrl, { method: 'PUT', headers: { 'Content-Range': `bytes */${size}` } });
    if (response.status === 200 || response.status === 201)
      return { done: true, file: (await response.json()) as DriveFile };
    if (response.status === 308) return { done: false, next: nextByte(response.headers.get('Range')) };
    if (response.status === 404 || response.status === 410) return { gone: true };
    throw await failure(response, 'carry on with the upload');
  }

  /**
   * Sends `blob` into the session from byte `from`, piece by piece. A dropped connection is asked about and carried
   * on from where Drive got to, a few times; then it is thrown as retryable, and the session address still works.
   *
   * @param onProgress - Called with the bytes Drive holds after each piece
   */
  async send(
    sessionUrl: string,
    blob: Blob,
    from: number,
    onProgress: (bytes: number) => Promise<void> | void,
    signal?: AbortSignal,
  ): Promise<DriveFile> {
    const size = blob.size;
    let offset = from;
    let resumes = 0;
    while (true) {
      signal?.throwIfAborted();
      if (offset >= size) {
        // Everything was sent, but the answer that says so was lost
        const state = await this.sessionStatus(sessionUrl, size);
        if ('gone' in state) throw new AppError('not_found', 'The upload to Google Drive expired.');
        if (state.done) return state.file;
        offset = state.next;
        continue;
      }
      const end = Math.min(offset + PIECE_BYTES, size);
      let response: Response;
      try {
        response = await this.call(sessionUrl, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${size}` },
          body: blob.slice(offset, end),
          signal,
        });
      } catch (error) {
        if (!isNetwork(error) || resumes >= RESUMES_PER_RUN) {
          throw new AppError('network', 'The connection to Google Drive dropped.', { retryable: true, cause: error });
        }
        resumes += 1;
        const state = await this.sessionStatus(sessionUrl, size).catch(() => null);
        if (!state) {
          throw new AppError('network', 'The connection to Google Drive dropped.', { retryable: true, cause: error });
        }
        if ('gone' in state) throw new AppError('not_found', 'The upload to Google Drive expired.');
        if (state.done) return state.file;
        offset = state.next;
        await onProgress(offset);
        continue;
      }
      if (response.status === 200 || response.status === 201) {
        await onProgress(size);
        return (await response.json()) as DriveFile;
      }
      if (response.status === 308) {
        offset = nextByte(response.headers.get('Range'));
        await onProgress(offset);
        continue;
      }
      if (response.status === 404 || response.status === 410) {
        throw new AppError('not_found', 'The upload to Google Drive expired.');
      }
      throw await failure(response, 'take the recording');
    }
  }

  /** The file's address in Drive. */
  async link(fileId: string): Promise<string | null> {
    const file = await this.json<DriveFile>(
      `${this.api}/files/${encodeURIComponent(fileId)}?fields=id,webViewLink`,
      { method: 'GET' },
      'find the recording',
    );
    return file.webViewLink ?? null;
  }

  /** Every "anyone with the link" permission the file has (one, unless two shares raced or Drive added one). */
  async anyonePermissions(fileId: string): Promise<string[]> {
    const list = await this.json<{ permissions?: { id: string; type: string }[] }>(
      `${this.api}/files/${encodeURIComponent(fileId)}/permissions?fields=permissions(id,type,role)`,
      { method: 'GET' },
      'read who can see the recording',
    );
    return (list.permissions ?? []).filter(permission => permission.type === 'anyone').map(permission => permission.id);
  }

  /** The "anyone with the link" permission the file has, if any. */
  async anyonePermission(fileId: string): Promise<string | null> {
    return (await this.anyonePermissions(fileId))[0] ?? null;
  }

  /** Anyone with the link can comment. Idempotent: a permission already there is kept, not made twice. */
  async share(fileId: string): Promise<{ permissionId: string; link: string | null }> {
    const existing = await this.anyonePermission(fileId);
    const permissionId =
      existing ??
      (
        await this.json<{ id: string }>(
          `${this.api}/files/${encodeURIComponent(fileId)}/permissions?fields=id&sendNotificationEmail=false`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify({ type: 'anyone', role: 'commenter', allowFileDiscovery: false }),
          },
          'share the recording',
        )
      ).id;
    return { permissionId, link: await this.link(fileId) };
  }

  /**
   * Private again: every "anyone" permission goes, the one Ava made and any other, so the link stops working
   * whatever made it public (a permission already gone is fine).
   */
  async unshare(fileId: string, permissionId: string | null): Promise<void> {
    const ids = new Set(await this.anyonePermissions(fileId));
    if (permissionId) ids.add(permissionId);
    for (const id of ids) {
      const response = await this.call(
        `${this.api}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      if (!response.ok && response.status !== 404) throw await failure(response, 'stop sharing the recording');
    }
  }
}
