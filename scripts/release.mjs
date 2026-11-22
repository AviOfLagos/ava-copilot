#!/usr/bin/env node
/**
 * Builds the public release artifacts from a clean `git worktree` of HEAD, so git-ignored local files
 * never ship to anyone else: the voice/wake models under public/ (scripts/voice-models-setup.mjs,
 * scripts/wake-word-setup.mjs, ~70 MB together) and any local .env.local — in particular
 * VITE_SEED_PROFILE=avi, which is what seeds the owner's own three personal workspaces instead of the
 * one neutral workspace everyone else gets (src/storage/lib/workspaces/workspaces.ts,
 * docs/distribution.md). A `git worktree` of a committed sha only ever contains tracked files, so this
 * is true by construction, not by a list of exclusions that could go stale.
 *
 * Writes, next to this checkout (uncommitted — see the ignore rule added for this in .gitignore):
 *
 *   site/public/download/ava-copilot-<version>.zip   the built, unpacked extension, zipped
 *   site/public/download/latest.json                 version, file, sha256, size, date, min browsers
 *   site/public/download/wake-word-setup.mjs          copies of the two setup scripts (with their own
 *   site/public/download/voice-models-setup.mjs       pinned sources' SHA-256s unchanged), so
 *                                                      site/public/install.sh's --with-voices can fetch
 *                                                      and run them without shipping ~70 MB in the zip
 *
 * Usage: node scripts/release.mjs
 * Needs: git, pnpm, Node 24+ (the worktree builds with the repo's own pinned toolchain; this script
 * itself only needs fflate, already a devDependency, and Node's own built-ins).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOWNLOAD_DIR = path.join(ROOT, 'site/public/download');
const SETUP_SCRIPTS = ['wake-word-setup.mjs', 'voice-models-setup.mjs'];

function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Every file under `dir`, recursively, as absolute paths. */
function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

/** Zips a built dist/ directory, then unzips it back in memory to catch a bug in this function
 * itself (a transport error after that, e.g. a cut-off download, is the installer's job: it checks
 * the SHA-256 this script writes to latest.json). */
function zipDirectory(dir) {
  const entries = {};
  for (const file of listFiles(dir)) {
    const rel = path.relative(dir, file).split(path.sep).join('/'); // zip entries always use `/`
    entries[rel] = [fs.readFileSync(file), { level: 9 }];
  }
  const zipped = zipSync(entries);
  const roundTrip = unzipSync(zipped);
  if (Object.keys(roundTrip).length !== Object.keys(entries).length) {
    throw new Error('Zip round-trip produced a different file count; refusing to publish it.');
  }
  return zipped;
}

/**
 * dist/ must never carry the git-ignored local models. Building from a `git worktree` of a committed
 * sha already guarantees this (untracked files are never in a worktree's checkout), but this checks
 * the actual shipped output too, so a future change to how they're ignored or built fails loudly here
 * instead of shipping ~70 MB silently.
 */
function assertNoBundledModels(distDir) {
  for (const dir of ['wake', 'voice']) {
    if (fs.existsSync(path.join(distDir, dir))) {
      throw new Error(
        `dist/${dir} exists in the release build — it must not ship. ` +
          `Check that public/${dir} is still git-ignored and untracked.`,
      );
    }
  }
}

/** Copies one of the two model setup scripts into the download dir, for install.sh --with-voices. */
function publishSetupScript(name) {
  const to = path.join(DOWNLOAD_DIR, name);
  fs.copyFileSync(path.join(ROOT, 'scripts', name), to);
  return { file: `download/${name}`, sha256: sha256File(to) };
}

async function main() {
  const status = git(['status', '--porcelain']);
  if (status) {
    console.warn(
      `Note: ${status.split('\n').length} uncommitted change(s) in the working tree.\n` +
        'The release always builds from the committed HEAD in a separate worktree, so none of them are in this build.\n',
    );
  }

  const sha = git(['rev-parse', 'HEAD']);
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-copilot-release-'));
  fs.rmdirSync(worktree); // `git worktree add` creates the directory itself

  console.log(`Building ${sha.slice(0, 12)} in a clean worktree (no git-ignored files): ${worktree}`);
  git(['worktree', 'add', '--detach', '--quiet', worktree, sha]);

  try {
    // Read the version from the clean worktree's own HEAD, not this checkout's working copy, so the
    // shipped zip's name and latest.json always match what was actually committed.
    const pkg = JSON.parse(fs.readFileSync(path.join(worktree, 'package.json'), 'utf8'));
    const version = pkg.version;

    // The worktree carries no .env.local (it is git-ignored), but strip VITE_SEED_PROFILE from the
    // environment too, in case it is ever set as a real shell variable rather than in that file.
    const env = { ...process.env };
    delete env.VITE_SEED_PROFILE;
    // Never ship the hosted-tracing ingest key: it is for the owner's own builds only.
    delete env.VITE_SUTURE_API_KEY;
    delete env.VITE_SUTURE_CAPTURE_CONTENT;

    console.log('Installing dependencies (frozen lockfile)…');
    execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: worktree, stdio: 'inherit', env });

    console.log('Building…');
    execFileSync('pnpm', ['build'], { cwd: worktree, stdio: 'inherit', env });

    const distDir = path.join(worktree, 'dist');
    if (!fs.existsSync(distDir)) throw new Error('pnpm build did not produce dist/');
    assertNoBundledModels(distDir);

    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    const zipName = `ava-copilot-${version}.zip`;
    // The site links a manual install to a name that never changes (written below, beside the versioned one)
    const latestZipName = 'ava-copilot-latest.zip';
    const zipPath = path.join(DOWNLOAD_DIR, zipName);
    console.log(`Zipping dist/ -> site/public/download/${zipName}`);
    fs.writeFileSync(zipPath, zipDirectory(distDir));
    fs.copyFileSync(zipPath, path.join(DOWNLOAD_DIR, latestZipName));

    const setupScripts = {
      wakeWordSetup: publishSetupScript(SETUP_SCRIPTS[0]),
      voiceModelsSetup: publishSetupScript(SETUP_SCRIPTS[1]),
    };

    const latest = {
      version,
      file: `download/${zipName}`,
      sha256: sha256File(zipPath),
      size: fs.statSync(zipPath).size,
      date: new Date().toISOString().slice(0, 10),
      commit: sha,
      // Chrome/Edge: chrome.sidePanel shipped in 114. Brave's own version numbers ride a Chromium
      // base; 1.60 is its first line on a Chromium known to carry it. Estimates, not measured on real
      // old installs — verify before publishing a real release (see docs/distribution.md).
      minBrowser: { chrome: '114', edge: '114', brave: '1.60' },
      // Raw setup-script copies for site/public/install.sh's --with-voices: it fetches these (never
      // the models directly) and runs them locally, so the base zip stays small and the models always
      // come from the exact pinned sources and SHA-256s in these two files.
      setupScripts,
    };
    fs.writeFileSync(path.join(DOWNLOAD_DIR, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');

    console.log(`\nDone: ${zipName} (${(latest.size / 1e6).toFixed(1)} MB), sha256 ${latest.sha256}`);
  } finally {
    console.log('Removing the temporary worktree…');
    git(['worktree', 'remove', '--force', worktree]);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
