import { describe, expect, it } from 'vitest';
import { DriveRecordings, nextByte, PIECE_BYTES } from '../drive';
import { API, fakeDrive, same, UPLOAD } from './fakeDrive';

const video = (size: number) => {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index++) bytes[index] = index % 251;
  return new Blob([bytes], { type: 'video/webm' });
};

function client(drive = fakeDrive()) {
  let token = 'token-1';
  const renewed: string[] = [];
  const recordings = new DriveRecordings({
    fetch: drive.fetch,
    token: async () => token,
    renew: async used => {
      renewed.push(used);
      token = 'token-2';
      return token;
    },
    api: API,
    uploadApi: UPLOAD,
  });
  return { drive, recordings, renewed };
}

describe('DriveRecordings', () => {
  it('reads the next byte from a Range header', () => {
    expect(nextByte(null)).toBe(0);
    expect(nextByte('bytes=0-262143')).toBe(262144);
  });

  it('makes "Ava recordings / <workspace>" once and finds it the next time', async () => {
    const { drive, recordings } = client();
    const first = await recordings.folder(['Nexprove']);
    const second = await recordings.folder(['Nexprove']);
    expect(first).toBe(second);
    expect(drive.folders().map(folder => folder.name)).toEqual(['Ava recordings', 'Nexprove']);
    // Two at once still make one of each
    await Promise.all([recordings.folder(['Acme']), recordings.folder(['Acme'])]);
    expect(drive.folders().filter(folder => folder.name === 'Acme')).toHaveLength(1);
  });

  it('uploads into one private file, piece by piece', async () => {
    const { drive, recordings } = client();
    const blob = video(PIECE_BYTES * 2 + 1000);
    const parentId = await recordings.folder(['Nexprove']);
    const session = await recordings.startSession({
      name: 'a.webm',
      parentId,
      mimeType: 'video/webm',
      size: blob.size,
    });
    const progress: number[] = [];
    const file = await recordings.send(session, blob, 0, bytes => void progress.push(bytes));
    expect(drive.uploads()).toHaveLength(1);
    const kept = drive.files.get(file.id)!;
    expect(await same(kept.bytes, blob)).toBe(true);
    expect(kept.parents).toEqual([parentId]);
    // Private: only its owner
    expect(kept.permissions.map(permission => permission.type)).toEqual(['user']);
    expect(drive.opensSignedOut(file.id)).toBe(false);
    expect(progress.at(-1)).toBe(blob.size);
  });

  it('carries on into the same file after the connection drops mid-upload', async () => {
    const { drive, recordings } = client();
    const blob = video(PIECE_BYTES * 3);
    const session = await recordings.startSession({
      name: 'a.webm',
      parentId: 'root',
      mimeType: 'video/webm',
      size: blob.size,
    });
    drive.dropOnce(PIECE_BYTES + 300_000);
    const file = await recordings.send(session, blob, 0, () => undefined);
    expect(drive.uploads()).toHaveLength(1);
    expect(await same(drive.files.get(file.id)!.bytes, blob)).toBe(true);
    // It asked Drive how far it got before carrying on
    expect(drive.calls.some(call => call.url === session && call.method === 'PUT')).toBe(true);
  });

  it('asks Drive where a saved session got to, and finishes it', async () => {
    const { drive, recordings } = client();
    const blob = video(PIECE_BYTES * 2);
    const session = await recordings.startSession({
      name: 'a.webm',
      parentId: 'root',
      mimeType: 'video/webm',
      size: blob.size,
    });
    await drive.fetch(session, {
      method: 'PUT',
      headers: { Authorization: 'Bearer token-1', 'Content-Range': `bytes 0-${PIECE_BYTES - 1}/${blob.size}` },
      body: blob.slice(0, PIECE_BYTES),
    });
    const state = await recordings.sessionStatus(session, blob.size);
    expect(state).toEqual({ done: false, next: PIECE_BYTES });
    const file = await recordings.send(session, blob, PIECE_BYTES, () => undefined);
    expect(drive.uploads()).toHaveLength(1);
    expect((await recordings.sessionStatus(session, blob.size)) as unknown).toMatchObject({
      done: true,
      file: { id: file.id },
    });
  });

  it('shares as "anyone with the link can comment", once, and stops sharing', async () => {
    const { drive, recordings } = client();
    const blob = video(1000);
    const session = await recordings.startSession({
      name: 'a.webm',
      parentId: 'root',
      mimeType: 'video/webm',
      size: blob.size,
    });
    const file = await recordings.send(session, blob, 0, () => undefined);
    const shared = await recordings.share(file.id);
    const again = await recordings.share(file.id);
    expect(again.permissionId).toBe(shared.permissionId);
    const anyone = drive.files.get(file.id)!.permissions.filter(permission => permission.type === 'anyone');
    expect(anyone).toEqual([{ id: shared.permissionId, type: 'anyone', role: 'commenter', allowFileDiscovery: false }]);
    expect(drive.opensSignedOut(file.id)).toBe(true);
    expect(shared.link).toContain(file.id);
    await recordings.unshare(file.id, shared.permissionId);
    expect(drive.opensSignedOut(file.id)).toBe(false);
    // Already private: nothing to remove, no error
    await recordings.unshare(file.id, shared.permissionId);
  });

  it('Stop sharing removes every "anyone" permission, not only the one Ava made', async () => {
    const { drive, recordings } = client();
    const blob = video(1000);
    const session = await recordings.startSession({
      name: 'a.webm',
      parentId: 'root',
      mimeType: 'video/webm',
      size: blob.size,
    });
    const file = await recordings.send(session, blob, 0, () => undefined);
    const shared = await recordings.share(file.id);
    // A second one, as from a share that raced or one added in Drive itself
    drive.files.get(file.id)!.permissions.push({ id: 'anyoneElse', type: 'anyone', role: 'reader' });
    await recordings.unshare(file.id, shared.permissionId);
    expect(drive.opensSignedOut(file.id)).toBe(false);
  });

  it("sends the token only to an upload address on Drive's own host", async () => {
    const asked: string[] = [];
    const drive = fakeDrive();
    const { recordings } = client({
      ...drive,
      fetch: (url: string, init?: RequestInit) => (asked.push(url), drive.fetch(url, init)),
    });
    expect(await recordings.sessionStatus('https://elsewhere.example/upload?upload_id=x', 10)).toEqual({ gone: true });
    expect(recordings.isSession('https://elsewhere.example/upload')).toBe(false);
    expect(recordings.isSession('http://' + new URL(UPLOAD).host + '/x')).toBe(false);
    expect(asked).toEqual([]);
  });

  it('renews a refused token once', async () => {
    const { drive, recordings, renewed } = client();
    drive.expireToken('token-2');
    await recordings.folder(['Nexprove']);
    expect(renewed).toEqual(['token-1']);
  });
});
