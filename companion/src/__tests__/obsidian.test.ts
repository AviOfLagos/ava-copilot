import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSafeNotePath, OBSIDIAN_LIMITS, OBSIDIAN_ROUTES } from '@protocol';
import { memoryLogger } from '../log';
import { confinedNotePath, resolveVaultRoot } from '../obsidian/paths';
import { obsidianVaultPaths, ObsidianVaults, vaultIdOf } from '../obsidian/vault';
import { startTestBrain, tempDir } from './helpers';

// Every test works in a temporary folder that stands in for ~: never the user's own vault
let home: ReturnType<typeof tempDir>;
let vault: string;
let outside: string;
let configPath: string;

function makeVault(path: string) {
  mkdirSync(join(path, '.obsidian'), { recursive: true });
}

beforeEach(() => {
  const made = tempDir();
  // macOS's temporary folder is reached through a symlink (/var → /private/var): use the real path
  home = { path: realpathSync(made.path), remove: made.remove };
  vault = join(home.path, 'Notes Vault');
  outside = join(home.path, 'secret');
  makeVault(vault);
  mkdirSync(join(vault, 'Projects'), { recursive: true });
  mkdirSync(join(vault, '.trash'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(vault, 'Welcome.md'), '# Welcome\nHello vault');
  writeFileSync(join(vault, 'Projects', 'Zedu.md'), 'The zedu tower plan');
  writeFileSync(join(vault, '.trash', 'Old.md'), 'gone');
  writeFileSync(join(vault, '.obsidian', 'app.md'), 'config');
  writeFileSync(join(vault, 'image.png'), 'png');
  writeFileSync(join(outside, 'passwords.md'), 'hunter2');
  const config = join(home.path, 'Library', 'Application Support', 'obsidian');
  mkdirSync(config, { recursive: true });
  configPath = join(config, 'obsidian.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      vaults: {
        a1: { path: vault, ts: 1, open: true },
        b2: { path: join(home.path, 'Missing'), ts: 2 },
        c3: { path: 'relative/path' },
        d4: { nope: true },
      },
    }),
  );
});

afterEach(() => home.remove());

const vaults = () =>
  new ObsidianVaults({ dataDir: home.path, log: memoryLogger(), home: home.path, obsidianConfig: configPath });

describe('vault discovery', () => {
  it('reads absolute paths from obsidian.json and ignores the rest', () => {
    expect(obsidianVaultPaths(readFileSync(configPath, 'utf8'))).toEqual([vault, join(home.path, 'Missing')]);
    expect(obsidianVaultPaths('not json')).toEqual([]);
    expect(obsidianVaultPaths('{"vaults": null}')).toEqual([]);
  });

  it('lists Obsidian’s vaults with whether each is usable', async () => {
    const { vaults: list, chosen } = await vaults().list();
    expect(chosen).toBeNull();
    expect(list.map(item => [item.name, item.usable, item.found])).toEqual([
      ['Notes Vault', true, 'obsidian'],
      ['Missing', false, 'obsidian'],
    ]);
  });

  it('has no vaults when Obsidian is not installed', async () => {
    const empty = new ObsidianVaults({
      dataDir: home.path,
      log: memoryLogger(),
      home: home.path,
      obsidianConfig: join(home.path, 'nothing.json'),
    });
    expect((await empty.list()).vaults).toEqual([]);
  });
});

describe('choosing a vault', () => {
  it('takes a typed path, ~ included, and keeps it', async () => {
    const store = vaults();
    const chosen = await store.choose('~/Notes Vault');
    expect(chosen.id).toBe(vaultIdOf(vault));
    expect((await vaults().list()).chosen?.id).toBe(chosen.id);
  });

  it('refuses folders that are not vaults', async () => {
    await expect(resolveVaultRoot(outside, home.path)).rejects.toThrow(/not an Obsidian vault/);
    await expect(resolveVaultRoot('relative/folder', home.path)).rejects.toThrow(/full path/);
    await expect(resolveVaultRoot(join(home.path, 'none'), home.path)).rejects.toThrow(/does not exist/);
    await expect(resolveVaultRoot(join(vault, 'Welcome.md'), home.path)).rejects.toThrow(/not a folder/);
    await expect(resolveVaultRoot('/', home.path)).rejects.toThrow();
  });

  it('refuses calls for a vault that is not the chosen one', async () => {
    const store = vaults();
    await expect(store.root(vaultIdOf(vault))).rejects.toThrow(/No Obsidian vault/);
    await store.choose(vault);
    await expect(store.root('0000000000000000')).rejects.toThrow(/different Obsidian vault/);
    store.forget();
    await expect(store.root(vaultIdOf(vault))).rejects.toThrow(/No Obsidian vault/);
  });
});

describe('path confinement', () => {
  it('accepts only Markdown notes without traversal or hidden parts', () => {
    for (const bad of [
      '../secret/passwords.md',
      'Projects/../../secret/passwords.md',
      '/etc/passwd.md',
      'Projects\\..\\x.md',
      '.obsidian/app.md',
      '.trash/Old.md',
      'Projects/.hidden.md',
      'image.png',
      'a//b.md',
      './a.md',
      'nul\u0000.md',
      'line\nbreak.md',
      ' spaced.md',
      '',
    ]) {
      expect(isSafeNotePath(bad), bad).toBe(false);
    }
    for (const good of ['Welcome.md', 'Projects/Zedu.md', '100% done.md', 'Ünïcödé/Nöte.MD']) {
      expect(isSafeNotePath(good), good).toBe(true);
    }
  });

  it('keeps percent-encoded traversal literal, inside the vault', async () => {
    const root = await resolveVaultRoot(vault, home.path);
    const target = await confinedNotePath(root, '%2e%2e/%2e%2e/secret/passwords.md', 'write');
    expect(target.startsWith(root + '/')).toBe(true);
    expect(target).toContain('%2e%2e');
  });

  it('refuses a symlinked folder or file that leads outside the vault', async () => {
    symlinkSync(outside, join(vault, 'Escape'));
    symlinkSync(join(outside, 'passwords.md'), join(vault, 'Link.md'));
    const root = await resolveVaultRoot(vault, home.path);
    await expect(confinedNotePath(root, 'Escape/passwords.md', 'read')).rejects.toThrow(/leaves the vault/);
    await expect(confinedNotePath(root, 'Escape/new.md', 'write')).rejects.toThrow(/linked folder/);
    await expect(confinedNotePath(root, 'Link.md', 'read')).rejects.toThrow(/leaves the vault/);
    await expect(confinedNotePath(root, 'Link.md', 'write')).rejects.toThrow(/linked file/);
  });

  it('follows a symlink for reading only while it stays inside the vault', async () => {
    symlinkSync(join(vault, 'Welcome.md'), join(vault, 'Alias.md'));
    const root = await resolveVaultRoot(vault, home.path);
    await expect(confinedNotePath(root, 'Alias.md', 'read')).resolves.toBe(join(root, 'Alias.md'));
    await expect(confinedNotePath(root, 'Alias.md', 'write')).rejects.toThrow(/linked file/);
  });

  it('resolves a vault reached through a symlink to its real folder', async () => {
    const link = join(home.path, 'VaultLink');
    symlinkSync(vault, link);
    expect(await resolveVaultRoot(link, home.path)).toBe(await resolveVaultRoot(vault, home.path));
  });
});

describe('notes', () => {
  let store: ObsidianVaults;
  let id: string;
  beforeEach(async () => {
    store = vaults();
    id = (await store.choose(vault)).id;
  });

  it('lists Markdown notes only, skipping hidden folders and symlinks, in pages', async () => {
    symlinkSync(outside, join(vault, 'Escape'));
    const first = await store.notes(id, { since: 0, cursor: null, limit: 1 });
    expect(first.notes.map(note => note.path)).toEqual(['Projects/Zedu.md']);
    expect(first.next).toBe('Projects/Zedu.md');
    const second = await store.notes(id, { since: 0, cursor: first.next, limit: 10 });
    expect(second.notes.map(note => note.path)).toEqual(['Welcome.md']);
    expect(second.next).toBeNull();
  });

  it('lists only notes changed since a time', async () => {
    const all = await store.notes(id, { since: 0, cursor: null, limit: 10 });
    const newest = Math.max(...all.notes.map(note => note.mtime));
    expect((await store.notes(id, { since: newest, cursor: null, limit: 10 })).notes).toEqual([]);
  });

  it('reads a batch, naming what it skipped', async () => {
    writeFileSync(join(vault, 'Big.md'), 'x'.repeat(OBSIDIAN_LIMITS.noteBytes + 1));
    const { notes, skipped } = await store.read(id, ['Welcome.md', 'Big.md', 'Nope.md']);
    expect(notes.map(note => [note.path, note.text])).toEqual([['Welcome.md', '# Welcome\nHello vault']]);
    expect(skipped).toEqual([
      { path: 'Big.md', reason: 'too_large' },
      { path: 'Nope.md', reason: 'missing' },
    ]);
  });

  it('creates notes and folders, never over an existing note', async () => {
    const made = await store.write(id, {
      path: 'Nex Copilot/Chats/One.md',
      text: 'source: avi-copilot\nhi',
      mode: 'create',
    });
    expect(made.created).toBe(true);
    expect(readFileSync(join(vault, 'Nex Copilot', 'Chats', 'One.md'), 'utf8')).toContain('hi');
    await expect(store.write(id, { path: 'Welcome.md', text: 'x', mode: 'create' })).rejects.toThrow(/already exists/);
  });

  it('overwrites only a note carrying the marker', async () => {
    await expect(
      store.write(id, { path: 'Welcome.md', text: 'replaced', mode: 'overwrite', onlyIfMarker: 'source: avi-copilot' }),
    ).rejects.toThrow(/not one Nex Copilot wrote/);
    expect(readFileSync(join(vault, 'Welcome.md'), 'utf8')).toContain('Hello vault');
    writeFileSync(join(vault, 'Ours.md'), '---\nsource: avi-copilot\n---\nold');
    const done = await store.write(id, {
      path: 'Ours.md',
      text: '---\nsource: avi-copilot\n---\nnew',
      mode: 'overwrite',
      onlyIfMarker: 'source: avi-copilot',
    });
    expect(done.created).toBe(false);
    expect(readFileSync(join(vault, 'Ours.md'), 'utf8')).toContain('new');
  });

  it('refuses writes that are too large or leave the vault', async () => {
    await expect(
      store.write(id, { path: 'Huge.md', text: 'x'.repeat(OBSIDIAN_LIMITS.noteBytes + 1), mode: 'create' }),
    ).rejects.toThrow(/too large/);
    await expect(store.write(id, { path: '../secret/x.md', text: 'x', mode: 'create' })).rejects.toThrow();
    symlinkSync(outside, join(vault, 'Escape'));
    await expect(store.write(id, { path: 'Escape/x.md', text: 'x', mode: 'create' })).rejects.toThrow(/linked folder/);
    expect(existsSync(join(outside, 'x.md'))).toBe(false);
  });

  it('removes only its own notes', async () => {
    await expect(store.remove(id, 'Welcome.md', 'source: avi-copilot')).rejects.toThrow(/not one Nex Copilot wrote/);
    writeFileSync(join(vault, 'Mentions.md'), 'Not front matter:\nsource: avi-copilot');
    await expect(store.remove(id, 'Mentions.md', 'source: avi-copilot')).rejects.toThrow(/not one Nex Copilot wrote/);
    writeFileSync(join(vault, 'Ours.md'), '---\nsource: avi-copilot\n---\nmine');
    expect(await store.remove(id, 'Ours.md', 'source: avi-copilot')).toBe(true);
    expect(await store.remove(id, 'Ours.md', 'source: avi-copilot')).toBe(false);
  });

  it('searches names first, then text, capped', async () => {
    const byName = await store.search(id, 'zedu', 10);
    expect(byName.results[0]).toMatchObject({ path: 'Projects/Zedu.md', title: 'Zedu' });
    const byText = await store.search(id, 'hello', 10);
    expect(byText.results).toEqual([
      expect.objectContaining({ path: 'Welcome.md', snippet: expect.stringContaining('Hello vault') }),
    ]);
    const capped = await store.search(id, '.md', 1);
    expect(capped.results).toHaveLength(1);
    expect(capped.truncated).toBe(true);
    expect((await store.search(id, 'hunter2', 10)).results).toEqual([]);
  });
});

describe('Obsidian routes', () => {
  it('need pairing, and refuse unsafe paths before touching the disk', async () => {
    const brain = await startTestBrain({ home: home.path, obsidianConfig: configPath });
    try {
      expect((await brain.api(OBSIDIAN_ROUTES.vaults, { token: null })).status).toBe(401);
      await brain.pair();
      const listed = (await (await brain.api(OBSIDIAN_ROUTES.vaults)).json()) as { vaults: { path: string }[] };
      expect(listed.vaults[0].path).toBe(await resolveVaultRoot(vault, home.path));
      const chosen = await brain.api(OBSIDIAN_ROUTES.choose, {
        body: JSON.stringify({ requestId: 'choose-0001', path: vault }),
      });
      const { vault: picked } = (await chosen.json()) as { vault: { id: string } };
      const traversal = await brain.api(OBSIDIAN_ROUTES.read, {
        body: JSON.stringify({ vaultId: picked.id, paths: ['../secret/passwords.md'] }),
      });
      expect(traversal.status).toBe(400);
      const read = await brain.api(OBSIDIAN_ROUTES.read, {
        body: JSON.stringify({ vaultId: picked.id, paths: ['Welcome.md'] }),
      });
      expect(((await read.json()) as { notes: { text: string }[] }).notes[0].text).toContain('Hello vault');
      const write = await brain.api(OBSIDIAN_ROUTES.write, {
        body: JSON.stringify({
          requestId: 'write-00001',
          vaultId: picked.id,
          path: 'Welcome.md',
          text: 'x',
          mode: 'overwrite',
          onlyIfMarker: 'source: avi-copilot',
        }),
      });
      expect(write.status).toBe(403);
    } finally {
      await brain.stop();
    }
  });
});
