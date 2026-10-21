import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSafeNotePath, OBSIDIAN_LIMITS, OBSIDIAN_ROUTES } from '@protocol';
import { memoryLogger } from '../log';
import { confinedNotePath, refusedVaultRoot, resolveVaultRoot } from '../obsidian/paths';
import { carriesMarker, obsidianVaultPaths, ObsidianVaults, vaultIdOf } from '../obsidian/vault';
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

// The temporary folders are under /private, a system folder: tests leave the system list out (it is tested apart)
const TEMP_OK: string[] = [];
const vaults = () =>
  new ObsidianVaults({
    dataDir: home.path,
    log: memoryLogger(),
    home: home.path,
    obsidianConfig: configPath,
    systemRoots: TEMP_OK,
  });

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
      systemRoots: TEMP_OK,
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
    await expect(resolveVaultRoot(outside, home.path, TEMP_OK)).rejects.toThrow(/not an Obsidian vault/);
    await expect(resolveVaultRoot('relative/folder', home.path, TEMP_OK)).rejects.toThrow(/full path/);
    await expect(resolveVaultRoot(join(home.path, 'none'), home.path, TEMP_OK)).rejects.toThrow(/does not exist/);
    await expect(resolveVaultRoot(join(vault, 'Welcome.md'), home.path, TEMP_OK)).rejects.toThrow(/not a folder/);
    await expect(resolveVaultRoot('/', home.path, TEMP_OK)).rejects.toThrow();
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

describe('vault roots', () => {
  it('refuses the disk, home and above, ~/Library, system and hidden folders', () => {
    const realHome = '/Users/avi';
    for (const bad of [
      '/',
      '/Users',
      '/Users/avi',
      '/Users/avi/Library',
      '/Users/avi/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault',
      '/Users/avi/.ssh',
      '/Users/avi/Notes/.hidden',
      '/System/Volumes',
      '/Library/Vault',
      '/private/var/tmp/v',
      '/etc',
      '/var/v',
      '/usr/local/v',
      '/bin',
      '/sbin',
      '/opt/homebrew',
    ]) {
      expect(refusedVaultRoot(bad, realHome), bad).not.toBeNull();
    }
    for (const good of ['/Users/avi/Documents/Vault', '/Users/avi/Notes', '/Volumes/Data/Vault']) {
      expect(refusedVaultRoot(good, realHome), good).toBeNull();
    }
  });

  it('compares the home folder by its real path', async () => {
    const link = join(home.path, 'HomeLink');
    symlinkSync(home.path, link);
    // Home given through a symlink is still refused as a vault
    makeVault(home.path);
    await expect(resolveVaultRoot(home.path, link, TEMP_OK)).rejects.toThrow(/home folder/);
  });

  it('refuses a vault under a system folder by default', async () => {
    // The temporary folder is under /private
    await expect(resolveVaultRoot(vault, home.path)).rejects.toThrow(/system folder/);
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
    const root = await resolveVaultRoot(vault, home.path, TEMP_OK);
    const target = await confinedNotePath(root, '%2e%2e/%2e%2e/secret/passwords.md', 'write');
    expect(target.startsWith(root + '/')).toBe(true);
    expect(target).toContain('%2e%2e');
  });

  it('refuses a symlinked folder or file that leads outside the vault', async () => {
    symlinkSync(outside, join(vault, 'Escape'));
    symlinkSync(join(outside, 'passwords.md'), join(vault, 'Link.md'));
    const root = await resolveVaultRoot(vault, home.path, TEMP_OK);
    await expect(confinedNotePath(root, 'Escape/passwords.md', 'read')).rejects.toThrow(/leaves the vault/);
    await expect(confinedNotePath(root, 'Escape/new.md', 'write')).rejects.toThrow(/linked folder/);
    await expect(confinedNotePath(root, 'Link.md', 'read')).rejects.toThrow(/leaves the vault/);
    await expect(confinedNotePath(root, 'Link.md', 'write')).rejects.toThrow(/linked file/);
  });

  it('follows a symlink for reading only while it stays inside the vault', async () => {
    symlinkSync(join(vault, 'Welcome.md'), join(vault, 'Alias.md'));
    const root = await resolveVaultRoot(vault, home.path, TEMP_OK);
    await expect(confinedNotePath(root, 'Alias.md', 'read')).resolves.toBe(join(root, 'Alias.md'));
    await expect(confinedNotePath(root, 'Alias.md', 'write')).rejects.toThrow(/linked file/);
  });

  it('resolves a vault reached through a symlink to its real folder', async () => {
    const link = join(home.path, 'VaultLink');
    symlinkSync(vault, link);
    expect(await resolveVaultRoot(link, home.path, TEMP_OK)).toBe(await resolveVaultRoot(vault, home.path, TEMP_OK));
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

  const OURS = '---\nsource: avi-copilot\n---\n';
  const ours = (path: string, text = 'old') => {
    mkdirSync(join(vault, ...path.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(vault, ...path.split('/')), `${OURS}${text}`);
  };

  it('creates notes and folders in its own folder, never over an existing note', async () => {
    const made = await store.write(id, { path: 'Nex Copilot/Chats/One.md', text: `${OURS}hi`, mode: 'create' });
    expect(made.created).toBe(true);
    expect(readFileSync(join(vault, 'Nex Copilot', 'Chats', 'One.md'), 'utf8')).toContain('hi');
    await expect(store.write(id, { path: 'Nex Copilot/Chats/One.md', text: 'x', mode: 'create' })).rejects.toThrow(
      /already exists/,
    );
  });

  it('writes and removes only under Nex Copilot/, in any case, whatever the mode', async () => {
    for (const mode of ['create', 'overwrite'] as const) {
      await expect(store.write(id, { path: 'Welcome.md', text: 'x', mode })).rejects.toThrow(/only writes in/);
      await expect(store.write(id, { path: 'Projects/New.md', text: 'x', mode })).rejects.toThrow(/only writes in/);
      await expect(store.write(id, { path: 'Nex Copilot.md', text: 'x', mode })).rejects.toThrow(/only writes in/);
    }
    // A note of the user's own outside the folder stays, even one that carries the marker
    ours('Projects/Copied.md');
    await expect(store.write(id, { path: 'Projects/Copied.md', text: 'x', mode: 'overwrite' })).rejects.toThrow(
      /only writes in/,
    );
    await expect(store.remove(id, 'Projects/Copied.md')).rejects.toThrow(/only writes in/);
    expect(readFileSync(join(vault, 'Welcome.md'), 'utf8')).toContain('Hello vault');
    expect(existsSync(join(vault, 'Projects', 'Copied.md'))).toBe(true);
    const lower = await store.write(id, { path: 'nex copilot/Lower.md', text: `${OURS}x`, mode: 'create' });
    expect(lower.created).toBe(true);
  });

  it('overwrites only a note whose front matter carries the fixed marker', async () => {
    mkdirSync(join(vault, 'Nex Copilot'), { recursive: true });
    writeFileSync(join(vault, 'Nex Copilot', 'Mine.md'), 'the user wrote this here');
    writeFileSync(join(vault, 'Nex Copilot', 'Mentions.md'), 'Not front matter:\nsource: avi-copilot');
    for (const path of ['Nex Copilot/Mine.md', 'Nex Copilot/Mentions.md']) {
      await expect(store.write(id, { path, text: 'replaced', mode: 'overwrite' })).rejects.toThrow(
        /not one Nex Copilot wrote/,
      );
    }
    expect(readFileSync(join(vault, 'Nex Copilot', 'Mine.md'), 'utf8')).toBe('the user wrote this here');
    ours('Nex Copilot/Ours.md');
    const done = await store.write(id, { path: 'Nex Copilot/Ours.md', text: `${OURS}new`, mode: 'overwrite' });
    expect(done.created).toBe(false);
    expect(readFileSync(join(vault, 'Nex Copilot', 'Ours.md'), 'utf8')).toContain('new');
    // A marker named in the request is not a thing any more: the fixed one is the only one
    expect(carriesMarker('---\nsource: someone-else\n---\n')).toBe(false);
  });

  it('refuses writes that are too large or leave the vault', async () => {
    await expect(
      store.write(id, { path: 'Nex Copilot/Huge.md', text: 'x'.repeat(OBSIDIAN_LIMITS.noteBytes + 1), mode: 'create' }),
    ).rejects.toThrow(/too large/);
    await expect(store.write(id, { path: '../secret/x.md', text: 'x', mode: 'create' })).rejects.toThrow();
    symlinkSync(outside, join(vault, 'Nex Copilot'));
    await expect(store.write(id, { path: 'Nex Copilot/x.md', text: 'x', mode: 'create' })).rejects.toThrow(
      /linked folder/,
    );
    expect(existsSync(join(outside, 'x.md'))).toBe(false);
  });

  it('removes only its own notes', async () => {
    mkdirSync(join(vault, 'Nex Copilot'), { recursive: true });
    writeFileSync(join(vault, 'Nex Copilot', 'Mine.md'), 'the user wrote this here');
    await expect(store.remove(id, 'Nex Copilot/Mine.md')).rejects.toThrow(/not one Nex Copilot wrote/);
    ours('Nex Copilot/Ours.md');
    expect(await store.remove(id, 'Nex Copilot/Ours.md')).toBe(true);
    expect(await store.remove(id, 'Nex Copilot/Ours.md')).toBe(false);
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
    const brain = await startTestBrain({ home: home.path, obsidianConfig: configPath, obsidianSystemRoots: TEMP_OK });
    try {
      expect((await brain.api(OBSIDIAN_ROUTES.vaults, { token: null })).status).toBe(401);
      await brain.pair();
      const listed = (await (await brain.api(OBSIDIAN_ROUTES.vaults)).json()) as { vaults: { path: string }[] };
      expect(listed.vaults[0].path).toBe(await resolveVaultRoot(vault, home.path, TEMP_OK));
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
        }),
      });
      // Outside Nex Copilot/: refused by the schema before Nex Brain looks at the disk
      expect(write.status).toBe(400);
      mkdirSync(join(vault, 'Nex Copilot'), { recursive: true });
      writeFileSync(join(vault, 'Nex Copilot', 'Mine.md'), 'mine');
      const theirs = await brain.api(OBSIDIAN_ROUTES.write, {
        body: JSON.stringify({
          requestId: 'write-00002',
          vaultId: picked.id,
          path: 'Nex Copilot/Mine.md',
          text: 'x',
          mode: 'overwrite',
        }),
      });
      expect(theirs.status).toBe(403);
      // Choosing again with the id it expects: a different folder is refused and nothing changes
      const other = join(home.path, 'Other Vault');
      mkdirSync(join(other, '.obsidian'), { recursive: true });
      const switched = await brain.api(OBSIDIAN_ROUTES.choose, {
        body: JSON.stringify({ requestId: 'choose-0002', path: other, expectVaultId: picked.id }),
      });
      expect(switched.status).toBe(404);
      const after = (await (await brain.api(OBSIDIAN_ROUTES.vaults)).json()) as { chosen: { id: string } };
      expect(after.chosen.id).toBe(picked.id);
    } finally {
      await brain.stop();
    }
  });
});
