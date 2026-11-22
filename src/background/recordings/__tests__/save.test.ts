import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(async () => {
  const { installChrome } = await import('../../backup/__tests__/helpers');
  installChrome();
});

import { AviCopilotDb, createOnceStore, createRecordingStore, RecordingsDb } from '@extension/storage';
import { DriveRecordings, PIECE_BYTES } from '../drive';
import { saveRecording } from '../save';
import type { BrainLike, SaveDeps } from '../save';
import { shareRecording, shareRecordingsFor, stopSharing } from '../share';
import type { ShareDeps } from '../share';
import { API, fakeDrive, same, UPLOAD } from './fakeDrive';
import type { FakeDrive } from './fakeDrive';

const TASK = 'tsk_aaaaaaaaaa';

function brain(paired = false) {
  const saved = new Map<string, string>();
  const sent: string[] = [];
  const requests: string[] = [];
  const fake: BrainLike & { saved: Map<string, string>; sent: string[]; requests: string[] } = {
    saved,
    sent,
    requests,
    paired: async () => paired,
    async recordingBegin(request) {
      requests.push(request.requestId);
      const path = saved.get(request.recordingId);
      if (path) return { ok: true, path };
      return { ok: true, uploadId: request.recordingId.padEnd(32, '0').slice(0, 32), chunkBytes: 1024 * 1024 };
    },
    async recordingChunk(_uploadId, _index, data) {
      sent.push(data);
      return { ok: true };
    },
    async recordingCommit(uploadId) {
      const id = [...saved.keys()].length;
      const path = `/Users/someone/Movies/Ava recordings/Nexprove/file${id}.webm`;
      saved.set(`rec_${uploadId.slice(4, 14)}`, path);
      return { ok: true, path };
    },
  };
  return fake;
}

async function setup(options: { drive?: FakeDrive | null; brain?: ReturnType<typeof brain> } = {}) {
  const store = createRecordingStore(new RecordingsDb(`rec-${crypto.randomUUID()}`));
  const once = createOnceStore(new AviCopilotDb(`once-${crypto.randomUUID()}`));
  const drive = options.drive === undefined ? fakeDrive() : options.drive;
  const links = new Map<string, { label: string; url: string }[]>();
  const nudges: number[] = [];
  const client = drive
    ? new DriveRecordings({
        fetch: drive.fetch,
        token: async () => 'token-1',
        renew: async () => 'token-1',
        api: API,
        uploadApi: UPLOAD,
      })
    : null;
  const deps: SaveDeps = {
    store,
    once,
    drive: async () => client,
    brain: options.brain ?? brain(false),
    workspaceName: async id => (id === 'ws_nexprove' ? 'Nexprove' : null),
    nudgeDrive: async () => void nudges.push(1),
  };
  const shareDeps: ShareDeps = {
    store,
    once,
    drive: async () => client,
    tasks: {
      addLink: async (taskId, link) => void links.set(taskId, [...(links.get(taskId) ?? []), link]),
      removeLink: async (taskId, url) =>
        void links.set(
          taskId,
          (links.get(taskId) ?? []).filter(item => item.url !== url),
        ),
    },
  };
  return { store, once, drive, deps, shareDeps, links, nudges };
}

async function recorded(store: ReturnType<typeof createRecordingStore>, bytes: number, title = 'Fix the login page') {
  const record = await store.create({
    taskId: TASK,
    workspaceId: 'ws_nexprove',
    title,
    surface: 'browser',
    withMic: true,
    withTabAudio: true,
    mimeType: 'video/webm;codecs=vp9,opus',
  });
  const piece = 1024 * 1024;
  for (let index = 0, offset = 0; offset < bytes; index++, offset += piece) {
    const size = Math.min(piece, bytes - offset);
    await store.addChunk(record.id, index, new Blob([new Uint8Array(size).fill(index + 1)]));
  }
  await store.update(record.id, { status: 'captured', endedAt: Date.now(), endedBy: 'stop', durationMs: 30_000 });
  return record.id;
}

describe('saving a recording', () => {
  it('goes to "Ava recordings / <workspace>" in Drive, as one private file, and the browser copy goes', async () => {
    const { store, deps, drive } = await setup();
    const id = await recorded(store, 3 * 1024 * 1024 + 17);
    const blob = (await store.blob(id))!;
    expect(await saveRecording(deps, id)).toBe('saved');
    const files = drive!.uploads();
    expect(files).toHaveLength(1);
    expect(files[0].name).toMatch(/^\d{4}-\d{2}-\d{2} Fix the login page\.webm$/);
    expect(files[0].mimeType).toBe('video/webm');
    expect(await same(files[0].bytes, blob)).toBe(true);
    const folder = drive!.files.get(files[0].parents[0])!;
    expect(folder.name).toBe('Nexprove');
    expect(drive!.files.get(folder.parents[0])!.name).toBe('Ava recordings');
    expect(drive!.opensSignedOut(files[0].id)).toBe(false);
    const record = (await store.get(id))!;
    expect(record.saved).toMatchObject({ where: 'drive', fileId: files[0].id, folder: 'Ava recordings / Nexprove' });
    expect(record.share.state).toBe('private');
    expect(record.upload).toBeNull();
    expect(await store.hasChunks(id)).toBe(false);
  });

  it('a retry after a dropped connection carries on into the same file: one file, not two', async () => {
    const { store, deps, drive } = await setup();
    const id = await recorded(store, PIECE_BYTES * 2 + 5000);
    const blob = (await store.blob(id))!;
    // The connection drops, and keeps dropping while Ava asks where it got to: the save gives up for now
    const flaky = drive!.fetch;
    let down = false;
    drive!.dropOnce(PIECE_BYTES + 1000);
    const original = deps.drive;
    deps.drive = async () =>
      new DriveRecordings({
        fetch: async (url, init) => {
          if (down) throw new TypeError('Failed to fetch');
          try {
            return await flaky(url, init);
          } catch (error) {
            down = true;
            throw error;
          }
        },
        token: async () => 'token-1',
        renew: async () => 'token-1',
        api: API,
        uploadApi: UPLOAD,
      });
    await expect(saveRecording(deps, id)).rejects.toMatchObject({ retryable: true });
    const halfway = (await store.get(id))!;
    expect(halfway.status).toBe('saving');
    expect(halfway.upload?.sessionUrl).toBeTruthy();
    expect(drive!.uploads()).toHaveLength(0);
    // The job runs it again once the connection is back
    down = false;
    deps.drive = original;
    expect(await saveRecording(deps, id)).toBe('saved');
    expect(drive!.uploads()).toHaveLength(1);
    expect(drive!.sessions.size).toBe(1);
    expect(await same(drive!.uploads()[0].bytes, blob)).toBe(true);
  });

  it('a save cut off after Drive took the file does not upload it again', async () => {
    const { store, deps, drive, once } = await setup();
    const id = await recorded(store, 2000);
    expect(await saveRecording(deps, id)).toBe('saved');
    // The background died after the do-once key was finished but before the record said so
    await store.update(id, { status: 'captured', saved: null });
    const keys = await once.forTask(`recording:${id}`);
    expect(keys.map(key => [key.what, key.status])).toEqual([['drive.upload', 'done']]);
    const blobless = await saveRecording({ ...deps, store: { ...deps.store, blob: async () => new Blob(['x']) } }, id);
    expect(blobless).toBe('saved');
    expect(drive!.uploads()).toHaveLength(1);
  });

  it('without Drive, goes to the Mac through Ava Brain, once', async () => {
    const mac = brain(true);
    const { store, deps, nudges } = await setup({ drive: null, brain: mac });
    const id = await recorded(store, 1500);
    expect(await saveRecording(deps, id)).toBe('saved');
    const record = (await store.get(id))!;
    expect(record.saved).toMatchObject({ where: 'brain' });
    expect(nudges).toEqual([]);
    // Asked again (a retry whose answer was lost): Ava Brain answers with the same path, no second file
    await store.update(id, { status: 'captured' });
    const again = await saveRecording({ ...deps, store: { ...deps.store, blob: async () => new Blob(['x']) } }, id);
    expect(again).toBe('saved');
    expect(mac.saved.size).toBe(1);
    // Each attempt asks afresh: a cached answer would hand back an upload a failed attempt left half-sent
    expect(new Set(mac.requests).size).toBe(mac.requests.length);
  });

  it('with neither, waits for a download from the panel and tells the Inbox once', async () => {
    const { store, deps, nudges } = await setup({ drive: null });
    const id = await recorded(store, 1500);
    expect(await saveRecording(deps, id)).toBe('waiting_download');
    expect(nudges).toEqual([1]);
    // The video stays in the browser until it is downloaded
    expect(await store.hasChunks(id)).toBe(true);
  });

  it('an empty recording is marked failed, not uploaded', async () => {
    const { store, deps, drive } = await setup();
    const record = await store.create({
      taskId: TASK,
      workspaceId: null,
      title: 'x',
      surface: 'browser',
      withMic: false,
      withTabAudio: false,
      mimeType: 'video/webm',
    });
    await store.update(record.id, { status: 'captured' });
    expect(await saveRecording(deps, record.id)).toBe('failed');
    expect(drive!.calls).toHaveLength(0);
  });

  it('never writes the token, the session address or a link to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(name =>
      vi.spyOn(console, name).mockImplementation(() => undefined),
    );
    const { store, deps, shareDeps } = await setup();
    const id = await recorded(store, 2000);
    await saveRecording(deps, id);
    const record = await shareRecording(shareDeps, id);
    await stopSharing(shareDeps, id);
    const printed = spies.flatMap(spy => spy.mock.calls.flat().map(String)).join('\n');
    expect(printed).not.toContain('token-1');
    expect(printed).not.toContain('drive.fake/upload/session');
    expect(printed).not.toContain(record.share.link!);
    spies.forEach(spy => spy.mockRestore());
  });
});

describe('sharing a recording', () => {
  it('Share makes "anyone with the link can comment", puts the link on the task; Stop sharing undoes both', async () => {
    const { store, deps, shareDeps, drive, links } = await setup();
    const id = await recorded(store, 2000);
    await saveRecording(deps, id);
    const fileId =
      (await store.get(id))!.saved!.where === 'drive'
        ? ((await store.get(id))!.saved as { fileId: string }).fileId
        : '';
    // Saved is private: no link works until Share
    expect(drive!.opensSignedOut(fileId)).toBe(false);
    expect(links.get(TASK)).toBeUndefined();

    const shared = await shareRecording(shareDeps, id);
    expect(shared.share).toMatchObject({ state: 'shared', round: 1 });
    expect(drive!.opensSignedOut(fileId)).toBe(true);
    expect(drive!.files.get(fileId)!.permissions.find(permission => permission.type === 'anyone')?.role).toBe(
      'commenter',
    );
    expect(links.get(TASK)).toEqual([{ label: expect.stringMatching(/^Screen recording /), url: shared.share.link }]);
    // Share again: still one permission, one link
    await shareRecording(shareDeps, id);
    expect(drive!.files.get(fileId)!.permissions.filter(permission => permission.type === 'anyone')).toHaveLength(1);
    expect(links.get(TASK)).toHaveLength(1);

    const stopped = await stopSharing(shareDeps, id);
    expect(stopped.share.state).toBe('private');
    expect(drive!.opensSignedOut(fileId)).toBe(false);
    expect(links.get(TASK)).toEqual([]);

    // Shared again after stopping: a new round, a new do-once key
    const again = await shareRecording(shareDeps, id);
    expect(again.share.round).toBe(2);
    expect(drive!.opensSignedOut(fileId)).toBe(true);
  });

  it('a recording that is not in Drive cannot be shared', async () => {
    const { store, deps, shareDeps } = await setup({ drive: null });
    const id = await recorded(store, 2000);
    await saveRecording(deps, id);
    await expect(shareRecording(shareDeps, id)).rejects.toThrow(/Google Drive/);
  });

  it('shareRecordingsFor shares what is in Drive for the tasks, and says why the rest was not', async () => {
    const { store, deps, shareDeps, drive } = await setup();
    const inDrive = await recorded(store, 2000);
    await saveRecording(deps, inDrive);
    const waiting = await recorded(store, 2000, 'Second take');
    const results = await shareRecordingsFor(shareDeps, [TASK, TASK]);
    expect(results.find(result => result.recordingId === inDrive)?.link).toBeTruthy();
    expect(results.find(result => result.recordingId === waiting)?.skipped).toBe('Not in Google Drive.');
    expect(drive!.uploads().filter(file => drive!.opensSignedOut(file.id))).toHaveLength(1);
  });

  it('shareRecordingsFor leaves alone a recording whose sharing was stopped by hand', async () => {
    const { store, deps, shareDeps, drive } = await setup();
    const id = await recorded(store, 2000);
    await saveRecording(deps, id);
    await shareRecording(shareDeps, id);
    await stopSharing(shareDeps, id);
    const results = await shareRecordingsFor(shareDeps, [TASK]);
    expect(results).toEqual([
      expect.objectContaining({ recordingId: id, link: null, skipped: 'Sharing was stopped for it.' }),
    ]);
    expect(drive!.uploads().filter(file => drive!.opensSignedOut(file.id))).toHaveLength(0);
  });
});
